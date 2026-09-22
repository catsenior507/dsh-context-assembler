import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createServer } from "node:http";
//#region src/host/surface.ts
/**
* Browser- and node-safe re-implementation of the two session-log folds this
* plugin reasons about: the ordered model-visible **surface** and the per-node
* **message projection**.
*
* The harness owns these rules (`@deepseek-ai/dsh-session`). This plugin
* cannot import that package — external plugin host halves resolve only
* cordis plus their own dependencies — so the folds are restated here against
* plain JSON events. Both are total functions of the log, which is what makes
* a context tree a *read* rather than plugin-owned state: nothing this plugin
* remembers can drift from what `session.deriveMessages()` will send.
*
* Everything in this module is pure and synchronous; the unit tests drive it
* with plain event arrays.
*
* @module dsh-context-assembler/host/surface
*/
/** The four event types that produce LLM messages and may carry a surface marker. */
const SURFACE_EVENT_TYPES = [
	"system/message",
	"user/message",
	"assistant/message",
	"tool/result"
];
/** Whether an event type produces a model message. */
function isSurfaceEventType(type) {
	return SURFACE_EVENT_TYPES.includes(type);
}
/**
* Fold a log prefix into its ordered surface.
*
* `append` pushes the event's seq; `replace` splices out the inclusive range
* `[startSeq, endSeq]` — resolved against the *current* surface order, exactly
* as the harness does — and puts the replacing event's own seq in its place.
* A malformed marker is skipped rather than thrown on: this is a read path, and
* a session the harness itself rejected would never have reached the log.
* @param events - the session's events in log order.
* @returns the surface, its shadow map, and where each replacement landed.
*/
function foldSurface(events) {
	const nodes = [];
	const shadowed = /* @__PURE__ */ new Map();
	const landing = /* @__PURE__ */ new Map();
	for (const event of events) {
		if (!isSurfaceEventType(event.type) || event.surfaceOp === void 0) continue;
		if (event.surfaceOp === "append") {
			nodes.push(event.seq);
			continue;
		}
		const { startSeq, endSeq } = event.surfaceOp;
		const startIdx = nodes.indexOf(startSeq);
		const endIdx = nodes.indexOf(endSeq);
		if (startIdx < 0 || endIdx < 0 || startIdx > endIdx) continue;
		shadowed.set(event.seq, nodes.slice(startIdx, endIdx + 1));
		nodes.splice(startIdx, endIdx - startIdx + 1, event.seq);
		landing.set(event.seq, startIdx);
	}
	return {
		nodes,
		shadowed,
		landing
	};
}
/**
* Project one event into the message it derives to, or null when it produces none.
*
* Mirrors `deriveEventMessage`: an empty-content system or assistant node is
* dormant (the harness uses that shape for "no system prompt" and for a
* max-tokens step that only carries usage), while a user message and a tool
* result always project.
* @param event - the event to project.
* @returns the message, or null when the event contributes no request content.
*/
function projectEvent(event) {
	switch (event.type) {
		case "user/message": return event.data;
		case "system/message":
		case "assistant/message": {
			const message = event.data.message;
			if (message === void 0 || !Array.isArray(message.content) || message.content.length === 0) return null;
			return message;
		}
		case "tool/result": return event.data.message ?? null;
		default: return null;
	}
}
/** Flatten one content block to the text a request would carry. */
function blockText(block) {
	const type = block["type"];
	if (type === "text" || type === "reasoning") {
		const text = block["text"];
		return typeof text === "string" ? text : "";
	}
	if (type === "tool-call") return `<${typeof block["name"] === "string" ? block["name"] : "tool"} ${typeof block["arguments"] === "string" ? block["arguments"] : ""}>`;
	if (type === "tool-result") return (Array.isArray(block["content"]) ? block["content"] : []).map(blockText).join("");
	if (type === "image") return "[image]";
	if (type === "file") return "[file]";
	return "";
}
/** Concatenate every text-bearing block of one message. */
function messageText(message) {
	if (message === null) return "";
	return message.content.map(blockText).filter((part) => part !== "").join("\n");
}
/** Tool-call blocks of one message, in order. */
function messageToolCalls(message) {
	if (message === null) return [];
	const calls = [];
	for (const block of message.content) {
		if (block["type"] !== "tool-call") continue;
		calls.push({
			id: typeof block["id"] === "string" ? block["id"] : "",
			name: typeof block["name"] === "string" ? block["name"] : "tool",
			arguments: typeof block["arguments"] === "string" ? block["arguments"] : ""
		});
	}
	return calls;
}
/** The tool-call id a tool result answers, when the block carries one. */
function toolResultCallId(message) {
	if (message === null) return null;
	const block = message.content[0];
	if (block === void 0 || block["type"] !== "tool-result") return null;
	const id = block["toolCallId"];
	return typeof id === "string" ? id : null;
}
/**
* Estimate the tokens one string costs.
*
* Deliberately a character-class heuristic rather than a tokenizer: the panel
* only needs comparable magnitudes (to rank what is worth folding), and a real
* tokenizer would be a large dependency resolved from a package this plugin is
* not allowed to import. CJK codepoints cost ~1 token each; ASCII runs ~1 per
* four characters; everything else sits between.
* @param text - the model-facing text.
* @returns an estimated token count.
*/
function estimateTokens(text) {
	if (text === "") return 0;
	let cjk = 0;
	let ascii = 0;
	let other = 0;
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		if (code < 128) ascii += 1;
		else if (code >= 11904 && code <= 40959) cjk += 1;
		else if (code >= 63744 && code <= 64255) cjk += 1;
		else if (code >= 65280 && code <= 65519) cjk += 1;
		else other += 1;
	}
	return Math.max(1, Math.ceil(cjk * 1 + ascii / 4 + other / 2));
}
//#endregion
//#region src/host/tree.ts
/** Source plugin id stamped on every replacement this plugin appends. */
const PLUGIN_ID = "@dsh-external/dsh-client-plugin-context-assembler";
/** Readable header the model sees above a folded body. */
function digestHeader(mode, items, tokens) {
	return "⟨assembled:" + (mode === "off" ? "off" : "key") + " items=" + items + " tokens≈" + tokens + "⟩";
}
/**
* Which assemble mode a replacement node encodes, or null when it is not ours.
*
* Two carriers are checked because the two replacement shapes differ (see
* {@link isOwnReplacement}): the `user/message` fold records the mode in
* `source.summary`, while the `tool/result` fold can only record it in the body
* text, where {@link digestHeader} already writes it. Both are plain log data,
* so the mode survives a restart as long as the harness persists the event —
* which it does.
* @param event - the replacement event to read.
* @returns the mode, or null when another producer made this node.
*/
function modeOfReplacement(event) {
	const source = event.data.source;
	if (source !== void 0 && source["plugin"] === "@dsh-external/dsh-client-plugin-context-assembler") {
		const summary = source["summary"];
		if (typeof summary === "string") {
			const match = /assembled:(key|off|full)/.exec(summary);
			if (match !== null) return match[1];
		}
	}
	if (event.type === "tool/result") {
		const match = /assembled:(key|off|full)/.exec(messageText(projectEvent(event)));
		if (match !== null) return match[1];
	}
	return null;
}
/**
* Whether this plugin produced the replacement node at that event.
*
* Two replacement shapes exist and they carry provenance differently. A
* multi-node fold is a `user/message` and can stamp `source.plugin`. A fold of a
* SINGLE tool result must stay a `tool/result` — the harness refuses any other
* shape there, because the node has to keep answering its assistant tool call —
* and that same guard forces every field except the result body to be byte
* identical to the original, `source` included. So the tool-result shape is
* recognised by the marker this plugin writes INTO the body instead.
*
* Getting this wrong is not cosmetic: the panel's fold count, the mode it shows
* on a reopened session, and the operations list all read through here, so a
* missed tool-result fold looks exactly like "my assembly was thrown away".
* @param event - the event to test.
* @returns the mode this plugin folded the region into, or null.
*/
function isOwnReplacement(event) {
	return modeOfReplacement(event) !== null;
}
/**
* Build the context tree for one session.
* @param input - the session's log, identity, presets, and linked children.
* @returns the rows the panel renders plus token accounting.
*/
function buildContextTree(input) {
	const events = input.events;
	const bySeq = /* @__PURE__ */ new Map();
	for (const event of events) bySeq.set(event.seq, event);
	const positions = inferPositions(events);
	const fold = foldSurface(events);
	const toolNames = toolNamesByCallId(events);
	input.presets;
	const depth = input.depth ?? 0;
	const onSurface = new Set(fold.nodes);
	const originalSeqs = [];
	for (const event of events) if (isSurfaceEventType(event.type) && event.surfaceOp === "append") originalSeqs.push(event.seq);
	const rows = [];
	let counter = 0;
	/**
	* Where a surface node SITS, which is not always where its event was written.
	*
	* A replacement node takes the surface position of the region it shadowed, so
	* grouping it by its own log position is wrong in a way that is very visible:
	* a digest written in turn 4 that swallowed turn-1 history would be grouped
	* under turn 4, splitting the surface into t4, t1, t5, t4, t5 — the older
	* context scatters into the wrong turns and the tree stops being a history at
	* all. Following the first shadowed node (recursively, so nested folds work)
	* puts the digest back where its content belongs.
	*/
	const positionCache = /* @__PURE__ */ new Map();
	const effectivePosition = (seq) => {
		const cached = positionCache.get(seq);
		if (cached !== void 0) return cached;
		const event = bySeq.get(seq);
		const replacement = event !== void 0 && event.surfaceOp !== void 0 && event.surfaceOp !== "append";
		let result;
		if (replacement) {
			const first = (fold.shadowed.get(seq) ?? [])[0];
			result = first === void 0 ? positions.get(seq) ?? {} : effectivePosition(first);
		} else result = positions.get(seq) ?? {};
		positionCache.set(seq, result);
		return result;
	};
	const rowFor = (seq, isShadowed) => {
		const event = bySeq.get(seq);
		const position = effectivePosition(seq);
		const childSeqs = fold.shadowed.get(seq) ?? [];
		const children = childSeqs.map((childSeq) => rowFor(childSeq, true));
		const replacement = event !== void 0 && event.surfaceOp !== void 0 && event.surfaceOp !== "append";
		const own = event !== void 0 && isOwnReplacement(event);
		const base = event === void 0 ? {
			id: "s" + seq,
			kind: "other",
			label: "未知事件 · seq " + seq,
			fromSeq: seq,
			toSeq: seq,
			turn: position.turn,
			step: position.step
		} : baseNodeFor(event, toolNames, position);
		const text = event === void 0 ? "" : messageText(projectEvent(event));
		const node = {
			...base,
			surfaceSeq: isShadowed ? null : seq,
			state: isShadowed ? "shadowed" : replacement ? "digest" : "live",
			mode: replacement ? modeOfReplacement(event) ?? "key" : "full",
			tokens: estimateTokens(text),
			chars: text.length,
			preview: text.slice(0, 400),
			selectable: true,
			shadowedSeqs: childSeqs.length > 0 ? childSeqs : void 0,
			children: children.length > 0 ? children : void 0,
			depth
		};
		if (isShadowed) {
			node.selectable = false;
			node.mode = "full";
			node.protectedReason = "已被折叠节点覆盖，请直接切换该折叠节点";
		}
		if (replacement) {
			node.label = own ? "组装区 · " + (node.mode === "off" ? "已移出" : "关键部分") + " · " + childSeqs.length + " 项" : "压缩区 · " + childSeqs.length + " 项";
			node.selectable = children.length > 0;
			if (children.length === 0) node.protectedReason = "该替换节点没有本插件可识别的来源";
		}
		if (fold.nodes[0] === seq) {
			node.selectable = false;
			node.protectedReason = "系统提示词占据表层第 0 号节点，harness 拒绝覆盖它的替换";
		}
		return node;
	};
	for (const seq of fold.nodes) {
		const node = rowFor(seq, false);
		const position = effectivePosition(seq);
		rows.push({
			node,
			turn: position.turn,
			step: position.step,
			order: counter++
		});
	}
	const orderAfter = (seq) => {
		let order = 0;
		for (const row of rows) {
			const rowSeq = row.node.surfaceSeq;
			if (rowSeq !== null && rowSeq <= seq) order = row.order + 1;
		}
		return order - .5;
	};
	const attemptRows = [];
	for (const event of events) {
		if (event.type !== "assistant/attempt") continue;
		const position = positions.get(event.seq) ?? {};
		attemptRows.push({
			node: {
				id: "a" + event.seq,
				kind: "attempt",
				label: "失败/未落地的模型尝试 · seq " + event.seq,
				surfaceSeq: null,
				fromSeq: event.seq,
				toSeq: event.seq,
				state: "shadowed",
				mode: "off",
				tokens: 0,
				chars: 0,
				preview: "",
				turn: position.turn,
				step: position.step,
				selectable: false,
				protectedReason: "该事件仅写入日志，不产生模型消息",
				depth
			},
			turn: position.turn,
			step: position.step,
			order: orderAfter(event.seq)
		});
	}
	const nodes = groupRows(rows.concat(attemptRows).sort((a, b) => a.order - b.order), depth);
	aggregate(nodes);
	const visibleTokens = rows.reduce((sum, row) => sum + row.node.tokens, 0);
	let shadowedTokens = 0;
	for (const seq of originalSeqs) {
		if (onSurface.has(seq)) continue;
		const event = bySeq.get(seq);
		if (event === void 0) continue;
		shadowedTokens += estimateTokens(messageText(projectEvent(event)));
	}
	const operations = [];
	for (const event of events) {
		if (!isOwnReplacement(event)) continue;
		const op = event.surfaceOp;
		if (op === void 0 || op === "append") continue;
		const mode = modeOfReplacement(event) ?? "key";
		const text = messageText(projectEvent(event));
		operations.push({
			seq: event.seq,
			time: event.time,
			startSeq: op.startSeq,
			endSeq: op.endSeq,
			mode: mode === "off" ? "off" : "key",
			label: mode === "off" ? "移出上下文" : mode === "full" ? "展开还原" : "只保留关键部分",
			chars: text.length
		});
	}
	const digestRows = rows.filter((row) => row.node.state === "digest");
	return {
		nodes,
		stats: {
			visibleTokens,
			shadowedTokens,
			rawTokens: visibleTokens + shadowedTokens,
			visibleMessages: rows.filter((row) => row.node.tokens > 0).length,
			surfaceNodes: fold.nodes.length,
			foldedRegions: digestRows.filter((row) => {
				const event = bySeq.get(row.node.surfaceSeq ?? -1);
				return event !== void 0 && isOwnReplacement(event);
			}).length,
			compactedRegions: digestRows.filter((row) => {
				const event = bySeq.get(row.node.surfaceSeq ?? -1);
				return event !== void 0 && !isOwnReplacement(event);
			}).length
		},
		operations
	};
}
/** One turn or step container row. */
function containerRow(id, kind, label, row, depth) {
	return {
		id,
		kind,
		label,
		surfaceSeq: null,
		fromSeq: row.node.fromSeq,
		toSeq: row.node.toSeq,
		state: "live",
		mode: "full",
		tokens: 0,
		chars: 0,
		preview: "",
		turn: row.turn,
		step: kind === "step" ? row.step : void 0,
		selectable: false,
		children: [],
		depth
	};
}
/**
* Group rows into turn and step containers, preserving surface order exactly.
*
* Grouping is over CONSECUTIVE rows only. A key-based regroup would read more
* naturally but would reorder the display whenever a boundary event lands
* between two messages of the same step — the system prompt is emitted inside
* the step while the user message that precedes it is not, so the two would
* swap places. Order is the one property the tree must never lose: the user is
* deciding what the model reads, in the order it reads it.
*/
function groupRows(rows, depth) {
	const out = [];
	let turnNode = null;
	let turnKey;
	let stepNode = null;
	let stepKey;
	for (const row of rows) {
		if (row.turn === void 0) {
			out.push(row.node);
			turnNode = null;
			turnKey = void 0;
			stepNode = null;
			stepKey = void 0;
			continue;
		}
		if (turnNode === null || turnKey !== row.turn) {
			turnNode = containerRow("t" + row.turn, "turn", "第 " + row.turn + " 轮", row, depth);
			out.push(turnNode);
			turnKey = row.turn;
			stepNode = null;
			stepKey = void 0;
		}
		if (row.step === void 0) {
			stepNode = null;
			stepKey = void 0;
			turnNode.children.push(row.node);
			continue;
		}
		if (stepNode === null || stepKey !== row.step) {
			stepNode = containerRow("s" + row.turn + "." + row.step + "-" + row.node.id, "step", "步骤 " + row.turn + "." + row.step, row, depth);
			turnNode.children.push(stepNode);
			stepKey = row.step;
		}
		stepNode.children.push(row.node);
	}
	return out;
}
/**
* Propagate child totals and ranges onto container rows.
*
* A digest row keeps its own state, mode, AND cost: it is a real surface node
* that happens to hold children (the events it replaced), so letting the
* children's totals overwrite it would price a fold at the size of everything
* it removed — the reported saving would be exactly zero. The children still
* aggregate their own seq ranges, which is what the row's coverage shows.
*/
function aggregate(nodes) {
	for (const node of nodes) {
		if (node.children === void 0 || node.children.length === 0) continue;
		aggregate(node.children);
		node.fromSeq = node.children.reduce((min, child) => child.fromSeq === null ? min : min === null ? child.fromSeq : Math.min(min, child.fromSeq), null);
		node.toSeq = node.children.reduce((max, child) => child.toSeq === null ? max : max === null ? child.toSeq : Math.max(max, child.toSeq), null);
		node.hint = gist(node, false) ?? gist(node, true);
		if (node.state === "digest") continue;
		node.tokens = node.children.reduce((sum, child) => sum + child.tokens, 0);
		node.chars = node.children.reduce((sum, child) => sum + child.chars, 0);
		node.state = new Set(node.children.map((child) => child.state)).size === 1 ? node.children[0].state : "live";
	}
}
/**
* Whether a line is a tool-call marker rather than something a person said.
*
* `messageText` renders each `tool-call` block as `<name {args}>`, so an
* assistant turn that only called a tool — the common shape in an agent loop —
* starts with the raw JSON of its arguments. Reporting that as the gist of a
* step is worse than reporting nothing: it is unreadable and it says only which
* tool ran, which the row's own kind already says. The closing bracket is
* optional because the preview is truncated mid-line.
*/
function isToolCallMarker(line) {
	return /^<[A-Za-z_][A-Za-z0-9_-]*[ >]/.test(line);
}
/**
* Collapse one text block down to a single readable line.
* @param text - the model-facing text.
* @returns the first line that is not blank and not a tool-call marker.
*/
function firstLine(text) {
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.replace(/\s+/g, " ").trim();
		if (line === "" || isToolCallMarker(line)) continue;
		return line.length > 72 ? line.slice(0, 72) + "…" : line;
	}
}
/**
* The one-line gist of a subtree, in row order.
*
* A collapsed container otherwise shows nothing but "步骤 2.7", which tells the
* user nothing about what the step was for; the panel needs the first thing
* that was actually said or run inside it. System nodes are skipped on the
* first pass because the rendered system prompt is the same 1.2k-token text in
* every session and would label almost every step identically; they are only
* used as a fallback when a region contains nothing else.
* @param node - the container or digest row to summarize.
* @param allowSystem - whether system nodes may supply the text.
* @returns the first non-empty line, or undefined when the subtree has no text.
*/
function gist(node, allowSystem) {
	if (node.state === "digest") {
		const own = firstLine(node.preview);
		if (own !== void 0) return own;
	}
	const children = node.children ?? [];
	if (children.length === 0) {
		if (!allowSystem && node.kind === "system") return void 0;
		const line = firstLine(node.preview);
		if (line === void 0) return void 0;
		if (node.kind === "tool" && node.toolName !== void 0 && !line.startsWith(node.toolName)) return "工具 " + node.toolName + " · " + line;
		return line;
	}
	for (const child of children) {
		if (!allowSystem && child.kind === "system") continue;
		const found = gist(child, allowSystem);
		if (found !== void 0) return found;
	}
}
/** The kind/label/role triple for one surface event. */
function baseNodeFor(event, toolNames, position) {
	const message = projectEvent(event);
	const common = {
		id: "s" + event.seq,
		fromSeq: event.seq,
		toSeq: event.seq,
		turn: position.turn,
		step: position.step
	};
	switch (event.type) {
		case "system/message": return {
			...common,
			kind: "system",
			label: "系统提示词 · seq " + event.seq,
			role: "system"
		};
		case "user/message": {
			const source = message?.source ?? {};
			const kind = source["kind"];
			const tag = kind === "user" ? "用户消息" : kind === "tool" ? "工具结果" : "注入上下文 · " + String(source["plugin"] ?? kind ?? "plugin");
			return {
				...common,
				kind: "user",
				label: tag + " · seq " + event.seq,
				role: "user"
			};
		}
		case "assistant/message": {
			const calls = messageToolCalls(message);
			const label = calls.length === 0 ? "助手消息 · seq " + event.seq : "助手消息 · " + calls.length + " 次工具调用 (" + calls.map((call) => call.name).join(", ") + ") · seq " + event.seq;
			return {
				...common,
				kind: "assistant",
				label,
				role: "assistant"
			};
		}
		case "tool/result": {
			const callId = toolResultCallId(message);
			const name = callId !== null ? toolNames.get(callId) : void 0;
			const isError = (message?.content[0])?.["isError"] === true;
			return {
				...common,
				kind: "tool",
				label: "工具 · " + (name ?? callId ?? "unknown") + (isError ? " · 失败" : "") + " · seq " + event.seq,
				role: "user",
				toolName: name ?? callId ?? void 0,
				toolCallId: callId ?? void 0,
				isError
			};
		}
		default: return {
			...common,
			kind: "other",
			label: event.type + " · seq " + event.seq
		};
	}
}
/** Map every tool-call id to the tool name that issued it. */
function toolNamesByCallId(events) {
	const names = /* @__PURE__ */ new Map();
	for (const event of events) {
		if (event.type !== "tool/call") continue;
		const callId = event.data["callId"];
		const name = event.data["name"];
		if (typeof callId === "string" && typeof name === "string") names.set(callId, name);
	}
	return names;
}
/** Infer turn/step for every event from the boundary events around it. */
function inferPositions(events) {
	const positions = /* @__PURE__ */ new Map();
	let turn;
	let step;
	for (const event of events) {
		if (event.type === "turn/start") {
			const value = event.data["turn"];
			if (typeof value === "number") turn = value;
			step = void 0;
		} else if (event.type === "turn/end") {
			positions.set(event.seq, {
				turn,
				step
			});
			turn = void 0;
			step = void 0;
			continue;
		} else if (event.type === "step/start") {
			const value = event.data["step"];
			if (typeof value === "number") step = value;
			const turnValue = event.data["turn"];
			if (typeof turnValue === "number") turn = turnValue;
		}
		const explicitTurn = event.data["turn"];
		const explicitStep = event.data["step"];
		positions.set(event.seq, {
			turn: typeof explicitTurn === "number" ? explicitTurn : turn,
			step: typeof explicitStep === "number" ? explicitStep : step
		});
	}
	return positions;
}
/** Evaluate preset rules against one row; first match wins. */
function matchPreset(node, presets) {
	for (const preset of presets) {
		if (!preset.enabled) continue;
		const match = preset.match;
		if (match.kind !== void 0 && match.kind !== node.kind) continue;
		if (match.toolName !== void 0 && match.toolName !== node.toolName) continue;
		if (match.isError !== void 0 && match.isError !== Boolean(node.isError)) continue;
		if (match.labelPattern !== void 0) {
			let re;
			try {
				re = new RegExp(match.labelPattern);
			} catch {
				continue;
			}
			if (!re.test(node.label)) continue;
		}
		return preset;
	}
	return null;
}
//#endregion
//#region src/host/planner.ts
/** Defaults chosen so a folded tool result keeps its verdict, its head, and its tail. */
const DEFAULT_DIGEST_OPTIONS = {
	offMarker: "({count} items, about {tokens} tokens omitted)",
	headLines: 12,
	tailLines: 4,
	maxChars: 6e3
};
let idCounter = 0;
/** Mint a log-safe message id for a synthesized node. */
function mintMessageId() {
	idCounter += 1;
	return "ca-" + Date.now().toString(36) + "-" + idCounter.toString(36) + "-" + Math.floor(Math.random() * 65535).toString(36);
}
/**
* Compile a plan.
* @param events - the session's events in log order.
* @param ops - requested modes keyed by the surface seq they toggle.
* @param options - digest rendering knobs.
* @returns the appends to commit plus human-readable notes about repairs.
*/
function compilePlan(events, ops, options = DEFAULT_DIGEST_OPTIONS) {
	const bySeq = /* @__PURE__ */ new Map();
	for (const event of events) bySeq.set(event.seq, event);
	const fold = foldSurface(events);
	const notes = [];
	if (ops.length === 0) return {
		instructions: [],
		notes
	};
	const indexOf = /* @__PURE__ */ new Map();
	fold.nodes.forEach((seq, index) => indexOf.set(seq, index));
	const current = /* @__PURE__ */ new Map();
	const mode = /* @__PURE__ */ new Map();
	const explicit = /* @__PURE__ */ new Map();
	fold.nodes.forEach((seq, index) => {
		const event = bySeq.get(seq);
		const value = event !== void 0 && event.surfaceOp !== void 0 && event.surfaceOp !== "append" ? modeOfReplacement(event) ?? "key" : "full";
		current.set(index, value);
		mode.set(index, value);
	});
	let touched = 0;
	for (const op of ops) {
		const index = indexOf.get(op.surfaceSeq);
		if (index === void 0) {
			notes.push("seq " + op.surfaceSeq + " 已不在当前表层上（可能已被其它折叠覆盖），已跳过");
			continue;
		}
		if (mode.get(index) === op.mode && explicit.get(index) === op.digest) continue;
		mode.set(index, op.mode);
		explicit.set(index, op.digest);
		touched += 1;
	}
	if (touched === 0) return {
		instructions: [],
		notes
	};
	const runs = [];
	let cursor = 0;
	while (cursor < fold.nodes.length) {
		const desired = mode.get(cursor) ?? "full";
		if (desired === "full") {
			cursor += 1;
			continue;
		}
		const startIdx = cursor;
		let digest;
		while (cursor < fold.nodes.length && (mode.get(cursor) ?? "full") === desired) {
			if (explicit.get(cursor) !== void 0) digest = explicit.get(cursor);
			cursor += 1;
		}
		const endIdx = cursor - 1;
		let changed = false;
		for (let at = startIdx; at <= endIdx; at += 1) if ((mode.get(at) ?? "full") !== (current.get(at) ?? "full")) {
			changed = true;
			break;
		}
		runs.push({
			startIdx,
			endIdx,
			mode: desired,
			digest,
			changed
		});
	}
	repairRuns(runs, toolCallGroups(fold.nodes, bySeq), fold.nodes, bySeq, notes);
	protectSystemHead(runs, fold.nodes, bySeq, notes);
	const instructions = [];
	for (const run of runs) {
		if (run.startIdx > run.endIdx || !run.changed) continue;
		const instruction = renderRun(run, fold, bySeq, options);
		if (instruction !== null) instructions.push(instruction);
	}
	fold.nodes.forEach((seq, at) => {
		if ((current.get(at) ?? "full") === "full") return;
		if ((mode.get(at) ?? "full") !== "full") return;
		const instruction = renderUnfold(seq, fold, bySeq);
		if (instruction !== null) instructions.push(instruction);
		else notes.push("seq " + seq + " 无法展开：该替换节点没有本插件可识别的来源");
	});
	instructions.sort((a, b) => a.op.startSeq - b.op.startSeq);
	return {
		instructions,
		notes
	};
}
/**
* Group every assistant message that requests tool calls with the results
* answering them, so a fold can never orphan a tool result.
* @param nodes - surface seqs in model order.
* @param bySeq - log lookup.
* @returns groups as inclusive index ranges; singletons are omitted.
*/
function toolCallGroups(nodes, bySeq) {
	const groups = [];
	const open = {
		calls: /* @__PURE__ */ new Set(),
		firstIdx: -1,
		lastIdx: -1
	};
	for (let index = 0; index < nodes.length; index += 1) {
		const event = bySeq.get(nodes[index]);
		if (event === void 0) continue;
		const message = projectEvent(event);
		if (event.type === "assistant/message") {
			const calls = messageToolCalls(message);
			if (calls.length === 0) {
				if (open.firstIdx >= 0) open.lastIdx = index;
				continue;
			}
			if (open.firstIdx >= 0) groups.push([open.firstIdx, open.lastIdx]);
			open.calls = new Set(calls.map((call) => call.id));
			open.firstIdx = index;
			open.lastIdx = index;
			continue;
		}
		if (event.type === "tool/result" && open.firstIdx >= 0) {
			const callId = toolResultCallId(message);
			if (callId !== null && open.calls.has(callId)) {
				open.calls.delete(callId);
				open.lastIdx = index;
				if (open.calls.size === 0) {
					groups.push([open.firstIdx, open.lastIdx]);
					open.firstIdx = -1;
					open.lastIdx = -1;
				}
			}
			continue;
		}
		if (open.firstIdx >= 0) open.lastIdx = index;
	}
	if (open.firstIdx >= 0) groups.push([open.firstIdx, open.lastIdx]);
	return groups;
}
/**
* Widen runs so no tool-call group is split, then merge runs that collide.
*
* The invariant is about what survives, not about range arithmetic. A group is
* assistant-tool-call plus every result answering it, and the provider rejects
* two shapes: a visible tool call with no result, and a visible result with no
* call. Folding the WHOLE group is always safe — both halves leave together.
*
* The one partial fold that is also safe is a lone tool result rendered as a
* tool/result replacement ({@link renderRun}): the node stays a tool result, only
* its body shrinks, so the correlation with the call survives. Every other
* partial overlap would delete one half and orphan the other, and is widened.
*/
function repairRuns(runs, groups, nodes, bySeq, notes) {
	const isSoloToolResult = (run) => {
		if (run.startIdx !== run.endIdx) return false;
		const event = bySeq.get(nodes[run.startIdx]);
		return event !== void 0 && event.type === "tool/result";
	};
	for (let guard = 0; guard < 64; guard += 1) {
		let widened = false;
		for (const run of runs) for (const [first, last] of groups) {
			if (run.startIdx > last || run.endIdx < first) continue;
			if (run.startIdx <= first && run.endIdx >= last) continue;
			if (isSoloToolResult(run)) continue;
			const newStart = Math.min(run.startIdx, first);
			const newEnd = Math.max(run.endIdx, last);
			run.startIdx = newStart;
			run.endIdx = newEnd;
			notes.push("为保持工具调用与结果成对，折叠范围已扩展到表层节点 seq " + first + "–" + last);
			widened = true;
		}
		runs.sort((a, b) => a.startIdx - b.startIdx);
		let merged = false;
		for (let i = 0; i + 1 < runs.length; i += 1) {
			const left = runs[i];
			const right = runs[i + 1];
			if (left.endIdx < right.startIdx) continue;
			if (left.mode !== right.mode) notes.push("相邻折叠区间的模式冲突，已按较早区间的模式合并");
			left.endIdx = Math.max(left.endIdx, right.endIdx);
			if (left.digest === void 0) left.digest = right.digest;
			left.changed = left.changed || right.changed;
			runs.splice(i + 1, 1);
			i -= 1;
			merged = true;
		}
		if (!widened && !merged) break;
	}
}
/** Shrink runs away from protected surface node 0. */
function protectSystemHead(runs, nodes, bySeq, notes) {
	const headSeq = nodes[0];
	if (headSeq === void 0) return;
	const head = bySeq.get(headSeq);
	if (head === void 0 || head.type !== "system/message") return;
	for (const run of runs) {
		if (run.startIdx !== 0) continue;
		run.startIdx = 1;
		if (run.endIdx === 0) notes.push("系统提示词不可折叠，已跳过");
		else notes.push("系统提示词不可折叠，折叠范围已从表层节点 seq " + nodes[1] + " 开始");
	}
}
/** Render one fold run into the single message that replaces it. */
function renderRun(run, fold, bySeq, options) {
	const seqs = fold.nodes.slice(run.startIdx, run.endIdx + 1);
	if (seqs.length === 0) return null;
	const startSeq = seqs[0];
	const endSeq = seqs[seqs.length - 1];
	const previousTokens = seqs.reduce((sum, seq) => sum + estimateTokens(messageText(projectEvent(bySeq.get(seq)))), 0);
	const items = countOriginals(seqs, fold, bySeq);
	if (seqs.length === 1) {
		const only = bySeq.get(seqs[0]);
		if (only !== void 0 && only.type === "tool/result") {
			const body = run.digest !== void 0 && run.digest !== "" ? run.digest : autoDigest([only], bySeq, options);
			const text = digestHeader(run.mode, items, previousTokens) + "\n" + body;
			const data = only.data;
			const block = data.message.content[0] ?? { type: "tool-result" };
			return {
				type: "tool/result",
				data: {
					...only.data,
					message: {
						...data.message,
						content: [{
							...block,
							content: [{
								type: "text",
								text
							}]
						}]
					}
				},
				sourceEventSeqs: [seqs[0]],
				op: {
					startSeq,
					endSeq,
					shadowedSeqs: seqs,
					mode: run.mode,
					event: "tool/result",
					label: "工具结果 · 关键部分",
					text,
					tokens: estimateTokens(text),
					previousTokens
				}
			};
		}
	}
	const body = run.mode === "off" ? options.offMarker.replace("{count}", String(items)).replace("{tokens}", String(previousTokens)) : run.digest !== void 0 && run.digest !== "" ? run.digest : autoDigest(seqs.map((seq) => bySeq.get(seq)).filter((event) => event !== void 0), bySeq, options);
	const raw = digestHeader(run.mode, items, previousTokens) + "\n" + body;
	const text = raw.length > options.maxChars ? raw.slice(0, options.maxChars) + "\n…（已截断）" : raw;
	if (run.mode === "off" && options.offMarker === "") return {
		type: "user/message",
		data: {
			id: synthesizedUserMessage("off", items, previousTokens, "").id,
			role: "user",
			content: [],
			source: {
				kind: "plugin",
				plugin: PLUGIN_ID,
				form: "notice",
				summary: "assembled:off items=" + items + " tokens=" + previousTokens
			}
		},
		sourceEventSeqs: seqs,
		op: {
			startSeq,
			endSeq,
			shadowedSeqs: seqs,
			mode: run.mode,
			event: "user/message",
			label: "移出上下文（零成本）",
			text: "",
			tokens: 0,
			previousTokens
		}
	};
	return {
		type: "user/message",
		data: synthesizedUserMessage(run.mode, items, previousTokens, text),
		sourceEventSeqs: seqs,
		op: {
			startSeq,
			endSeq,
			shadowedSeqs: seqs,
			mode: run.mode,
			event: "user/message",
			label: run.mode === "off" ? "移出上下文" : "关键部分",
			text,
			tokens: estimateTokens(text),
			previousTokens
		}
	};
}
/** Build the `user/message` payload this plugin appends as a replacement node. */
function synthesizedUserMessage(mode, items, tokens, text) {
	return {
		id: mintMessageId(),
		role: "user",
		content: [{
			type: "text",
			text
		}],
		source: {
			kind: "plugin",
			plugin: PLUGIN_ID,
			form: "notice",
			summary: "assembled:" + mode + " items=" + items + " tokens=" + tokens
		}
	};
}
/** Count the recorded events a run ultimately covers, nested folds included. */
function countOriginals(seqs, fold, bySeq) {
	let total = 0;
	for (const seq of seqs) {
		const nested = fold.shadowed.get(seq);
		if (nested !== void 0 && nested.length > 0) total += countOriginals(nested, fold, bySeq);
		else total += 1;
	}
	return total;
}
/** Open one folded region again. */
function renderUnfold(seq, fold, bySeq) {
	const event = bySeq.get(seq);
	if (event === void 0) return null;
	const shadowedSeqs = fold.shadowed.get(seq) ?? [];
	if (shadowedSeqs.length === 0) return null;
	const previousTokens = estimateTokens(messageText(projectEvent(event)));
	const restoredTokens = shadowedSeqs.reduce((sum, shadowSeq) => {
		const original = bySeq.get(shadowSeq);
		return original === void 0 ? sum : sum + estimateTokens(messageText(projectEvent(original)));
	}, 0);
	if (shadowedSeqs.length === 1) {
		const restored = restoreVerbatim(event, bySeq.get(shadowedSeqs[0]), previousTokens);
		if (restored !== null) return restored;
	}
	return restoreTranscript(event, shadowedSeqs, bySeq, previousTokens, restoredTokens);
}
/**
* Restore a fold that covered exactly one recorded event, in that event's own
* role shape where the harness permits it.
* @param digestEvent - the replacement node currently on the surface.
* @param original - the recorded event being brought back.
* @param previousTokens - what the digest costs today.
* @returns the append, or null when the original's role shape cannot be re-emitted.
*/
function restoreVerbatim(digestEvent, original, previousTokens) {
	if (original === void 0) return null;
	if (original.type === "tool/result" && digestEvent.type === "tool/result") {
		const originalData = original.data;
		const digestData = digestEvent.data;
		const originalBlock = originalData.message.content[0];
		const digestBlock = digestData.message.content[0] ?? { type: "tool-result" };
		const text = messageText(projectEvent(original));
		return {
			type: "tool/result",
			data: {
				...digestEvent.data,
				message: {
					...digestData.message,
					content: [{
						...digestBlock,
						content: originalBlock?.["content"] ?? []
					}]
				}
			},
			sourceEventSeqs: [digestEvent.seq],
			op: {
				startSeq: digestEvent.seq,
				endSeq: digestEvent.seq,
				shadowedSeqs: [digestEvent.seq],
				mode: "full",
				event: "tool/result",
				label: "展开还原",
				text,
				tokens: estimateTokens(text),
				previousTokens
			}
		};
	}
	if (original.type === "user/message") {
		const message = original.data;
		const text = messageText(projectEvent(original));
		return {
			type: "user/message",
			data: {
				...message,
				id: mintMessageId()
			},
			sourceEventSeqs: [digestEvent.seq],
			op: {
				startSeq: digestEvent.seq,
				endSeq: digestEvent.seq,
				shadowedSeqs: [digestEvent.seq],
				mode: "full",
				event: "user/message",
				label: "展开还原",
				text,
				tokens: estimateTokens(text),
				previousTokens
			}
		};
	}
	if (original.type === "assistant/message") {
		const kept = (projectEvent(original)?.content ?? []).filter((block) => block["type"] !== "tool-call");
		const text = messageText(projectEvent(original));
		const content = [{
			type: "text",
			text: "⟨assembled:full items=1⟩ 以下为展开还原的助手消息（seq " + original.seq + "）；工具调用块无法在单条 user 消息中保留，已省略。"
		}, ...kept];
		return {
			type: "user/message",
			data: {
				id: mintMessageId(),
				role: "user",
				content,
				source: {
					kind: "plugin",
					plugin: PLUGIN_ID,
					form: "notice",
					summary: "assembled:full items=1"
				}
			},
			sourceEventSeqs: [digestEvent.seq],
			op: {
				startSeq: digestEvent.seq,
				endSeq: digestEvent.seq,
				shadowedSeqs: [digestEvent.seq],
				mode: "full",
				event: "user/message",
				label: "展开还原",
				text,
				tokens: estimateTokens(text),
				previousTokens
			}
		};
	}
	return null;
}
/** Replay a multi-node fold as one delimited transcript message. */
function restoreTranscript(digestEvent, shadowedSeqs, bySeq, previousTokens, restoredTokens) {
	const lines = ["⟨assembled:full items=" + shadowedSeqs.length + "⟩ 以下为展开还原的原样重放，按日志顺序；各段保留其原始角色标注。"];
	for (const seq of shadowedSeqs) {
		const event = bySeq.get(seq);
		if (event === void 0) continue;
		lines.push("", "--- seq " + seq + " · " + event.type + " ---", messageText(projectEvent(event)));
	}
	const text = lines.join("\n");
	return {
		type: "user/message",
		data: synthesizedUserMessage("full", shadowedSeqs.length, restoredTokens, text),
		sourceEventSeqs: [digestEvent.seq],
		op: {
			startSeq: digestEvent.seq,
			endSeq: digestEvent.seq,
			shadowedSeqs: [digestEvent.seq],
			mode: "full",
			event: "user/message",
			label: "展开还原（重放）",
			text,
			tokens: estimateTokens(text),
			previousTokens
		}
	};
}
/**
* Derive "the key parts" of a region without asking a model.
*
* The rule is deliberately mechanical: keep the verdict (which member, whether
* it failed), the first lines that usually state what happened, and the last
* lines that usually state the outcome. Everything between becomes a counted
* ellipsis, so the model can see that something was elided and how much. An
* agent that wants a semantic digest passes one explicitly through the tool.
* @param events - the region's surface events in order.
* @param bySeq - log lookup, kept for call-site symmetry.
* @param options - head/tail line budgets and the character ceiling.
* @returns the digest body.
*/
function autoDigest(events, bySeq, options = DEFAULT_DIGEST_OPTIONS) {
	const blocks = [];
	for (const event of events) {
		const message = projectEvent(event);
		if (message === null) continue;
		const text = messageText(message);
		if (text.trim() === "") continue;
		const lines = text.split(/\r?\n/);
		if (lines.length <= options.headLines + options.tailLines + 1) {
			blocks.push("▸ " + describe(event, message) + "\n" + text);
			continue;
		}
		const head = lines.slice(0, options.headLines).join("\n");
		const tail = lines.slice(-options.tailLines).join("\n");
		const omitted = lines.length - options.headLines - options.tailLines;
		blocks.push("▸ " + describe(event, message) + "\n" + head + "\n…（省略 " + omitted + " 行）…\n" + tail);
	}
	const body = blocks.join("\n\n");
	if (body.length <= options.maxChars) return body;
	return body.slice(0, options.maxChars) + "\n…（已截断）";
}
/** One-line description of a region member, used as a digest section header. */
function describe(event, message) {
	if (event.type === "assistant/message") {
		const calls = messageToolCalls(message);
		return "assistant · seq " + event.seq + (calls.length > 0 ? " · 工具调用 " + calls.map((call) => call.name).join(", ") : "");
	}
	if (event.type === "tool/result") {
		const block = message.content[0];
		return "tool-result · seq " + event.seq + (block?.["isError"] === true ? " · 失败" : "");
	}
	if (event.type === "user/message") return "user · seq " + event.seq;
	if (event.type === "system/message") return "system · seq " + event.seq;
	return event.type + " · seq " + event.seq;
}
//#endregion
//#region src/host/service.ts
/**
* Host-half orchestration: read a context tree, compile and commit plans,
* persist preset rules.
*
* The host half deliberately duck-types every harness service it touches.
* An external dsh plugin node half resolves only `@deepseek-ai/cordis` plus
* its own dependencies — `@deepseek-ai/dsh-session`, `dsh-tools` and friends
* are not reachable from a linked package — so importing their types would
* silently inline a second copy of a runtime contract. The interfaces below
* restate exactly the surface this plugin uses, and every call site degrades
* gracefully when a service is absent (a headless profile has no webServer,
* for instance).
*
* @module dsh-context-assembler/host/service
*/
/** Tool names whose calls may have spawned a subagent session. */
const DELEGATION_TOOLS = /* @__PURE__ */ new Set([
	"subagent",
	"subagent_fork",
	"workflow",
	"run_code"
]);
/** Resolve the plugin data directory. */
function resolveDataDir(configured) {
	if (configured !== void 0 && configured !== "") return configured;
	const home = process.env.DSH_HOME ?? process.env.USERPROFILE ?? process.env.HOME ?? homedir();
	const base = home.endsWith(".dsh") ? home : join(home, ".dsh");
	return join(base, "context-assembler");
}
/** Fill in defaults for a partial configuration. */
function resolveConfig(partial) {
	const input = partial ?? {};
	return {
		port: typeof input.port === "number" && input.port > 0 ? input.port : 4799,
		dataDir: resolveDataDir(input.dataDir),
		offMarker: input.offMarker ?? "（{count} 项已移出上下文，约 {tokens} tokens）",
		digestHeadLines: input.digestHeadLines ?? 12,
		digestTailLines: input.digestTailLines ?? 4,
		digestMaxChars: input.digestMaxChars ?? 6e3,
		exposeTool: input.exposeTool !== false
	};
}
/** How long a failed stored-session read waits before being retried. */
const FAILURE_RETRY_MS = 12e4;
/** Normalise raw log records into the plain events this plugin folds. */
function toLogEvents(raw) {
	const out = [];
	for (const item of raw) {
		const event = item;
		if (event === null || typeof event !== "object") continue;
		if (typeof event.seq !== "number" || typeof event.type !== "string") continue;
		out.push({
			type: event.type,
			seq: event.seq,
			time: typeof event.time === "number" ? event.time : 0,
			data: event.data ?? {},
			surfaceOp: event.surfaceOp,
			sourceEventSeqs: event.sourceEventSeqs
		});
	}
	return out;
}
/** Read a live session log as plain events this plugin can fold. */
function readEvents(session) {
	return toLogEvents(session.snapshotEvents());
}
/** Render the current derived history for the panel "what the model sees" strip. */
function describeMessages(session) {
	const messages = session.deriveMessages();
	const out = [];
	messages.forEach((item, index) => {
		const message = item;
		const role = message.role === "system" || message.role === "assistant" ? message.role : "user";
		const text = messageText({
			role,
			content: message.content ?? []
		});
		const source = message.source ?? {};
		const kind = typeof source["kind"] === "string" ? source["kind"] : "user";
		const plugin = typeof source["plugin"] === "string" ? source["plugin"] : "";
		out.push({
			index,
			role,
			source: kind === "plugin" ? "plugin:" + plugin : kind,
			chars: text.length,
			tokens: estimateTokens(text),
			preview: text.slice(0, 200)
		});
	});
	return out;
}
/**
* The same message list for a session that is not live.
*
* A stored session has no Session object to ask, so the list is rebuilt from
* the log: the surface fold picks the nodes the model would read, and each one
* projects to its message exactly as it does for a live session.
* @param events - the stored log.
* @returns one row per message the model would receive.
*/
function describeMessagesFromEvents(events) {
	const bySeq = /* @__PURE__ */ new Map();
	for (const event of events) bySeq.set(event.seq, event);
	const out = [];
	for (const seq of foldSurface(events).nodes) {
		const event = bySeq.get(seq);
		if (event === void 0) continue;
		const message = projectEvent(event);
		if (message === null) continue;
		const role = message.role === "system" || message.role === "assistant" ? message.role : "user";
		const text = messageText(message);
		const source = message.source ?? {};
		const kind = typeof source["kind"] === "string" ? source["kind"] : "user";
		const plugin = typeof source["plugin"] === "string" ? source["plugin"] : "";
		out.push({
			index: out.length,
			role,
			source: kind === "plugin" ? "plugin:" + plugin : kind,
			chars: text.length,
			tokens: estimateTokens(text),
			preview: text.slice(0, 200)
		});
	}
	return out;
}
/** Depth-first walk over a row list. */
function flatten(nodes) {
	const out = [];
	const stack = [...nodes];
	while (stack.length > 0) {
		const node = stack.pop();
		out.push(node);
		if (node.children !== void 0) stack.push(...node.children);
	}
	return out;
}
/** A stable, readable preset id. */
function mintPresetId() {
	return "preset-" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 65535).toString(36);
}
/** The context-assembly host service: tree reads, plan commits, and presets. */
var ContextAssembler = class {
	store;
	config;
	digest;
	presetPath;
	draftPath;
	indexPath;
	persistence;
	log;
	index = {
		version: 1,
		entries: {}
	};
	meterLookup;
	indexing = false;
	readFailures = 0;
	lastReadError;
	presets = {
		version: 1,
		sessions: {}
	};
	drafts = {
		version: 1,
		sessions: {}
	};
	constructor(store, config, persistence, log, meterLookup) {
		this.meterLookup = meterLookup ?? (() => void 0);
		this.persistence = persistence ?? (() => void 0);
		this.log = log ?? (() => void 0);
		this.store = store;
		this.config = config;
		this.digest = {
			offMarker: config.offMarker,
			headLines: config.digestHeadLines,
			tailLines: config.digestTailLines,
			maxChars: config.digestMaxChars
		};
		this.presetPath = join(config.dataDir, "presets.json");
		this.draftPath = join(config.dataDir, "drafts.json");
		this.indexPath = join(config.dataDir, "sessions-index.json");
		this.loadPresets();
		this.loadDrafts();
		this.loadIndex();
	}
	/**
	* Start reading stored-session summaries in the background.
	*
	* Called once when the plugin mounts, so the picker already knows real
	* titles by the time anybody opens it. Nothing here is on a request path:
	* the reads are single-flight and every caller keeps working with whatever
	* the index holds right now.
	*/
	warmIndex() {
		const attempt = (remaining) => {
			if (this.persistence() !== void 0) {
				this.refreshIndex();
				return;
			}
			if (remaining <= 0) return;
			setTimeout(() => attempt(remaining - 1), 1500).unref?.();
		};
		attempt(10);
	}
	/** Public configuration, for the panel footer. */
	describeConfig() {
		return this.config;
	}
	/**
	* Every session the panel can open: the live ones plus every stored one.
	*
	* The stored half is the point. The harness only pulls a conversation into
	* the live store once somebody opens it, so a list built from the store alone
	* silently hides every past conversation — the panel looks empty exactly when
	* the user wants to look back at something.
	* @returns picker rows, newest first.
	*/
	async listSessions() {
		let newest = -1;
		const rows = [];
		const known = /* @__PURE__ */ new Set();
		for (const session of this.store.list()) {
			const events = readEvents(session);
			const updatedAt = events.length === 0 ? session.header?.createdAt ?? 0 : events[events.length - 1].time;
			newest = Math.max(newest, updatedAt);
			known.add(session.id);
			rows.push({
				id: session.id,
				title: this.titleOf(events, session.id),
				cwd: session.header?.cwd,
				parentSessionId: session.header?.parentSession,
				createdAt: session.header?.createdAt ?? 0,
				updatedAt,
				events: events.length,
				recent: false,
				cold: false
			});
		}
		const persistence = this.persistence();
		if (persistence !== void 0) try {
			for (const snapshot of await persistence.list()) {
				const id = snapshot.header?.id;
				if (typeof id !== "string" || id === "" || known.has(id)) continue;
				known.add(id);
				const createdAt = snapshot.header?.createdAt ?? 0;
				const summary = this.index.entries[id];
				rows.push({
					id,
					title: summary === void 0 ? "" : summary.title,
					cwd: snapshot.header?.cwd,
					parentSessionId: snapshot.header?.parentSession,
					createdAt,
					updatedAt: summary === void 0 ? createdAt : summary.updatedAt,
					events: summary === void 0 ? 0 : summary.events,
					sizeBytes: snapshot.sizeBytes,
					readError: summary?.error,
					recent: false,
					cold: true
				});
			}
			this.refreshIndex();
		} catch {}
		for (const row of rows) row.recent = row.updatedAt === newest;
		rows.sort((a, b) => b.updatedAt - a.updatedAt);
		return rows;
	}
	/** The session id the panel should open by default, preferring a live one. */
	async defaultSessionId() {
		const rows = await this.listSessions();
		const live = rows.filter((row) => row.cold !== true);
		const pool = live.length > 0 ? live : rows;
		const top = pool.find((row) => row.parentSessionId === void 0) ?? pool[0];
		return top === void 0 ? null : top.id;
	}
	/**
	* Read one session context tree, live or stored.
	*
	* A live session is read from the store and stays editable. A stored one is
	* read from persistence with `read` access, which takes no ownership and
	* leaves the conversation untouched — the whole point being that looking at a
	* past conversation must not require reopening (and therefore forking) it.
	* @param sessionId - the session to read.
	* @param depth - nesting depth below the root read.
	* @param seen - sessions already visited, guarding against cycles.
	* @returns the tree, flagged read-only when the session is not live.
	*/
	async readTree(sessionId, depth = 0, seen = /* @__PURE__ */ new Set()) {
		const session = this.store.get(sessionId);
		if (session !== void 0) {
			const built = this.buildFor(session, depth, seen);
			this.attachSubagents(built.nodes, session, depth, seen);
			return {
				ok: true,
				sessionId,
				title: this.titleOf(readEvents(session), session.id),
				cwd: session.header?.cwd,
				readOnly: false,
				stats: built.stats,
				nodes: built.nodes,
				operations: built.operations,
				presets: this.presetsFor(sessionId),
				draft: this.draftFor(sessionId),
				at: Date.now()
			};
		}
		const events = await this.readStoredEvents(sessionId);
		if (events === void 0) {
			const reason = this.index.entries[sessionId]?.error;
			throw new Error(reason === void 0 ? "会话 " + sessionId + " 既不在活动会话表里，也没有找到持久化记录" : "会话 " + sessionId + " 的日志读不出来：" + reason);
		}
		const built = buildContextTree({
			sessionId,
			title: this.titleOf(events, sessionId),
			events,
			presets: this.presetsFor(sessionId)
		});
		return {
			ok: true,
			sessionId,
			title: this.titleOf(events, sessionId),
			cwd: void 0,
			readOnly: true,
			stats: built.stats,
			nodes: built.nodes,
			operations: built.operations,
			presets: this.presetsFor(sessionId),
			draft: this.draftFor(sessionId),
			at: Date.now()
		};
	}
	/**
	* Context pressure for one session, preferring the provider-anchored figure.
	*
	* Summing the message list is a heuristic over whatever the surface happens to
	* hold. The meter reports what the provider actually charged the last request
	* at. The second is the number a reader should trust, so it wins when present,
	* and the caller is told which one it got.
	*
	* Only live sessions can be measured: a stored log is replayed as text, and
	* pricing it would invent a route it was never sent under.
	* @param sessionId - the session to measure.
	* @returns the measured size and whether it is provider-anchored, or null.
	*/
	usageFor(sessionId) {
		const session = this.store.get(sessionId);
		if (session === void 0) return null;
		const meter = this.meterLookup();
		if (meter === void 0) return null;
		try {
			const tokens = meter.measure(session)?.totalTokens;
			if (typeof tokens === "number" && tokens > 0) return {
				tokens,
				anchored: true
			};
		} catch {}
		return null;
	}
	/** The derived history for any session, live or stored. */
	async messagesFor(sessionId) {
		const session = this.store.get(sessionId);
		if (session !== void 0) return describeMessages(session);
		const events = await this.readStoredEvents(sessionId);
		return events === void 0 ? [] : describeMessagesFromEvents(events);
	}
	/**
	* Read a stored log without opening the conversation.
	*
	* `read` access never claims ownership, so this works while another process
	* (or the live agent) holds the session. Every failure degrades to undefined:
	* a profile without persistence, or an unreadable artifact, must read as
	* "not available" rather than break the panel.
	* @param sessionId - the stored session to read.
	* @returns its events, or undefined when they cannot be read.
	*/
	async readStoredEvents(sessionId) {
		const persistence = this.persistence();
		if (persistence === void 0) return void 0;
		let handle;
		try {
			handle = await persistence.open(sessionId, "read");
			return toLogEvents((await handle.read()).events ?? []);
		} catch (error) {
			this.lastReadError = String(error);
			this.readFailures += 1;
			if (this.readFailures <= 12) this.log("[context-assembler] 读取已存会话失败 " + sessionId + "：" + String(error));
			return;
		} finally {
			try {
				await handle?.close?.();
			} catch {}
		}
	}
	/**
	* Compile a plan and, unless it is a dry run, commit it to the session log.
	* @param request - target session, the toggles, and whether presets run first.
	* @param dryRun - when true nothing is appended; only the compiled ops come back.
	* @returns the compiled ops, the appended seqs, and the resulting message list.
	*/
	async applyPlan(request, dryRun) {
		const session = this.requireSession(request.sessionId);
		const ops = [];
		const notes = [];
		const claimed = /* @__PURE__ */ new Set();
		if (request.applyPresets === true) {
			const tree = await this.readTree(request.sessionId);
			for (const node of flatten(tree.nodes)) {
				if (node.surfaceSeq === null || !node.selectable) continue;
				const preset = matchPreset(node, this.presetsFor(request.sessionId));
				if (preset === null) continue;
				ops.push({
					surfaceSeq: node.surfaceSeq,
					mode: preset.mode,
					digest: preset.template
				});
				claimed.add(node.surfaceSeq);
			}
			if (ops.length > 0) notes.push("预设规则匹配到 " + ops.length + " 个节点");
		}
		for (const op of request.ops) {
			if (claimed.has(op.surfaceSeq)) continue;
			ops.push(op);
		}
		const compiled = compilePlan(readEvents(session), ops, this.digest);
		notes.push(...compiled.notes);
		const compiledOps = compiled.instructions.map((instruction) => instruction.op);
		const appendedSeqs = [];
		if (!dryRun) for (const instruction of compiled.instructions) {
			const payload = {
				surfaceOp: {
					op: "replace",
					startSeq: instruction.op.startSeq,
					endSeq: instruction.op.endSeq
				},
				sourceEventSeqs: instruction.sourceEventSeqs
			};
			const appended = session.append(instruction.type, instruction.data, payload);
			if (appended !== void 0 && typeof appended.seq === "number") appendedSeqs.push(appended.seq);
		}
		const previous = compiledOps.reduce((sum, op) => sum + op.previousTokens, 0);
		const now = compiledOps.reduce((sum, op) => sum + op.tokens, 0);
		return {
			ok: true,
			sessionId: request.sessionId,
			dryRun,
			ops: compiledOps,
			appendedSeqs,
			savedTokens: previous - now,
			notes,
			messages: describeMessages(session)
		};
	}
	/** Replace the preset rules stored for one session. */
	setPresets(sessionId, presets) {
		this.presets.sessions[sessionId] = presets.map((preset) => ({
			...preset,
			id: preset.id === void 0 || preset.id === "" ? mintPresetId() : preset.id
		}));
		this.savePresets();
		return this.presetsFor(sessionId);
	}
	/** The derived history one session currently sends, for the API and the tool. */
	describeMessagesFor(session) {
		return describeMessages(session);
	}
	/**
	* Preset rules in force for one session: its own entry, else the nearest
	* ancestor's.
	* @param sessionId - the session being read.
	* @returns the stored rules, or an empty list.
	*/
	presetsFor(sessionId) {
		for (const id of this.ancestry(sessionId)) {
			const entry = this.presets.sessions[id];
			if (entry !== void 0) return entry;
		}
		return [];
	}
	/** Replace the unapplied plan saved for one session. */
	setDraft(sessionId, ops) {
		if (ops.length === 0) this.drafts.sessions[sessionId] = [];
		else this.drafts.sessions[sessionId] = ops;
		this.saveDrafts();
		return this.drafts.sessions[sessionId] ?? [];
	}
	/** The unapplied plan a session (or its nearest recorded ancestor) left behind. */
	draftFor(sessionId) {
		for (const id of this.ancestry(sessionId)) {
			const entry = this.drafts.sessions[id];
			if (entry !== void 0) return entry;
		}
		return [];
	}
	/**
	* The session and its ancestry, nearest first.
	*
	* The walk stops at the first ancestor that is no longer live, because its
	* own parent is unknowable from here — but that ancestor's id is still in the
	* chain, so entries recorded against it are still found.
	* @param sessionId - the session to trace.
	* @returns session ids, nearest first.
	*/
	ancestry(sessionId) {
		const chain = [sessionId];
		const seen = /* @__PURE__ */ new Set([sessionId]);
		let current = this.store.get(sessionId);
		for (let depth = 0; depth < 32 && current !== void 0; depth += 1) {
			const parentId = current.header?.parentSession;
			if (parentId === void 0 || parentId === "" || seen.has(parentId)) break;
			chain.push(parentId);
			seen.add(parentId);
			current = this.store.get(parentId);
		}
		return chain;
	}
	/** Resolve a live session or throw a readable error. */
	requireSession(sessionId) {
		const session = this.store.get(sessionId);
		if (session === void 0) throw new Error("会话 " + sessionId + " 不在活动会话表中。历史会话可以在面板里查看，但要改动它得先在左侧会话列表里把这个对话打开。");
		return session;
	}
	/** Build one session tree without subagent attachment. */
	buildFor(session, depth, seen) {
		seen.add(session.id);
		return buildContextTree({
			sessionId: session.id,
			title: this.titleOf(readEvents(session), session.id),
			cwd: session.header?.cwd,
			events: readEvents(session),
			presets: this.presetsFor(session.id),
			depth
		});
	}
	/**
	* Nest live subagent sessions under the tool node that produced them.
	*
	* The log records no parent pointer on a tool result, so the link is
	* inferred: an exact mention of the child session id in the tool result text
	* first, then the first unclaimed delegation-shaped tool node. Unlinked
	* children are surfaced at the root, so a session is never invisible merely
	* because the inference failed.
	*/
	attachSubagents(nodes, root, depth, seen) {
		if (depth >= 3) return;
		const children = this.store.list().filter((session) => {
			return session.header?.parentSession === root.id && !seen.has(session.id);
		});
		if (children.length === 0) return;
		const bySeq = /* @__PURE__ */ new Map();
		for (const event of readEvents(root)) bySeq.set(event.seq, event);
		const unassigned = /* @__PURE__ */ new Map();
		for (const child of children) unassigned.set(child.id, child);
		for (const node of flatten(nodes)) {
			if (node.surfaceSeq === null) continue;
			const event = bySeq.get(node.surfaceSeq);
			if (event === void 0) continue;
			const text = messageText(projectEvent(event));
			let matched;
			for (const child of unassigned.values()) if (text.includes(child.id)) {
				matched = child;
				break;
			}
			if (matched === void 0 && node.toolName !== void 0 && DELEGATION_TOOLS.has(node.toolName)) for (const child of unassigned.values()) {
				matched = child;
				break;
			}
			if (matched === void 0) continue;
			unassigned.delete(matched.id);
			const wrapper = this.subagentWrapper(matched, depth, seen, false);
			if (node.children === void 0) node.children = [wrapper];
			else node.children.push(wrapper);
			node.label = node.label + " → 子代理";
		}
		for (const child of unassigned.values()) nodes.push(this.subagentWrapper(child, depth, seen, true));
	}
	/** One subagent container row, with the child session tree inside. */
	subagentWrapper(child, depth, seen, orphan) {
		const childTree = this.buildFor(child, depth + 1, seen);
		this.attachSubagents(childTree.nodes, child, depth + 1, seen);
		const prefix = orphan ? "未挂载的子代理会话 · " : "子代理会话 · ";
		return {
			id: "sub-" + child.id,
			kind: "session",
			label: prefix + this.titleOf(readEvents(child), child.id),
			surfaceSeq: null,
			fromSeq: null,
			toSeq: null,
			state: "live",
			mode: "full",
			tokens: childTree.stats.visibleTokens,
			chars: 0,
			preview: "子会话 " + child.id + " 拥有独立表层；请在会话列表中切换过去再装配它",
			selectable: false,
			protectedReason: "子代理拥有独立会话，其上下文在自己的表层上装配",
			children: childTree.nodes,
			depth: depth + 1
		};
	}
	/**
	* A short readable title for one session, taken from its first user message.
	*
	* Log-based rather than store-based so a stored session, which has no live
	* object to ask, is titled exactly like a live one.
	* @param events - the session log.
	* @param fallbackId - used when the log carries no user message yet.
	* @returns the title.
	*/
	titleOf(events, fallbackId) {
		const firstUser = events.find((event) => {
			if (event.type !== "user/message") return false;
			return event.data.source?.kind === "user";
		});
		if (firstUser === void 0) return fallbackId;
		const text = messageText(projectEvent(firstUser)).replace(/\s+/g, " ").trim();
		return text === "" ? fallbackId : text.slice(0, 48);
	}
	/** Load the preset table from disk, tolerating a missing or corrupt file. */
	loadPresets() {
		try {
			if (!existsSync(this.presetPath)) return;
			const parsed = JSON.parse(readFileSync(this.presetPath, "utf8"));
			if (parsed !== null && typeof parsed === "object" && parsed.sessions !== void 0) this.presets = {
				version: 1,
				sessions: parsed.sessions
			};
		} catch {
			this.presets = {
				version: 1,
				sessions: {}
			};
		}
	}
	/** Persist the preset table. */
	savePresets() {
		try {
			mkdirSync(dirname(this.presetPath), { recursive: true });
			writeFileSync(this.presetPath, JSON.stringify(this.presets, null, 2), "utf8");
		} catch {}
	}
	/** Load the draft table, tolerating a missing or corrupt file. */
	loadDrafts() {
		try {
			if (!existsSync(this.draftPath)) return;
			const parsed = JSON.parse(readFileSync(this.draftPath, "utf8"));
			if (parsed !== null && typeof parsed === "object" && parsed.sessions !== void 0) this.drafts = {
				version: 1,
				sessions: parsed.sessions
			};
		} catch {
			this.drafts = {
				version: 1,
				sessions: {}
			};
		}
	}
	/**
	* Persist the draft table.
	*
	* A draft is the user's unapplied plan. It is deliberately NOT the session
	* log: nothing the model reads changes until 应用 is pressed. Persisting it
	* only means a reload or a host restart no longer throws the work away.
	*/
	saveDrafts() {
		try {
			mkdirSync(dirname(this.draftPath), { recursive: true });
			writeFileSync(this.draftPath, JSON.stringify(this.drafts, null, 2), "utf8");
		} catch {}
	}
	/** Load the stored-session summary cache, tolerating a missing or corrupt file. */
	loadIndex() {
		try {
			if (!existsSync(this.indexPath)) return;
			const parsed = JSON.parse(readFileSync(this.indexPath, "utf8"));
			if (parsed !== null && typeof parsed === "object" && parsed.entries !== void 0) this.index = {
				version: 1,
				entries: parsed.entries
			};
		} catch {
			this.index = {
				version: 1,
				entries: {}
			};
		}
	}
	/**
	* Persist the stored-session summary cache.
	*
	* Written through a temporary file and renamed, because this file is
	* rewritten once per summary and a torn read is not a cosmetic problem: the
	* loader falls back to an empty table on a parse failure, so half a file
	* would cost every title read so far.
	*/
	saveIndex() {
		const temporary = this.indexPath + ".tmp";
		try {
			mkdirSync(dirname(this.indexPath), { recursive: true });
			writeFileSync(temporary, JSON.stringify(this.index, null, 2), "utf8");
			renameSync(temporary, this.indexPath);
		} catch {}
	}
	/**
	* Summarise a stored session: its title, its event count, and its recency.
	*
	* The title comes from the newest `session/title` event, which is the same
	* value the harness sidebar shows. Falling back to the first user message
	* covers conversations that never got a generated title.
	* @param sessionId - the stored session to read.
	* @returns the summary, or undefined when the log cannot be read.
	*/
	async summariseStored(sessionId) {
		const events = await this.readStoredEvents(sessionId);
		if (events === void 0) return void 0;
		let title = "";
		for (const event of events) {
			if (event.type !== "session/title") continue;
			const value = event.data.title;
			if (typeof value === "string" && value.trim() !== "") title = value.trim();
		}
		const last = events[events.length - 1];
		return {
			title: title === "" ? this.titleOf(events, sessionId) : title,
			events: events.length,
			updatedAt: last === void 0 ? 0 : last.time
		};
	}
	/**
	* Fill in summaries for stored sessions that have none, or whose log changed.
	*
	* Deliberately fire-and-forget and single-flight: the caller gets a list
	* immediately and titles appear as the reads land, instead of the picker
	* blocking on reading every stored log before it can render.
	* @returns nothing; the index is updated in place.
	*/
	async refreshIndex() {
		if (this.indexing) return;
		const persistence = this.persistence();
		if (persistence === void 0) return;
		this.indexing = true;
		try {
			const pending = [...await persistence.list()].sort((a, b) => (a.sizeBytes ?? 0) - (b.sizeBytes ?? 0));
			for (const snapshot of pending) {
				const id = snapshot.header?.id;
				if (typeof id !== "string" || id === "") continue;
				const sizeBytes = snapshot.sizeBytes ?? 0;
				const known = this.index.entries[id];
				if (known !== void 0) {
					if (known.error === void 0) {
						if (sizeBytes > 0 && known.sizeBytes === sizeBytes) continue;
					} else if (Date.now() - (known.failedAt ?? 0) < FAILURE_RETRY_MS) continue;
				}
				this.lastReadError = void 0;
				const summary = await this.summariseStored(id);
				if (summary === void 0) this.index.entries[id] = {
					title: "",
					events: 0,
					updatedAt: snapshot.header?.createdAt ?? 0,
					sizeBytes,
					error: this.lastReadError ?? "unknown failure",
					failedAt: Date.now()
				};
				else this.index.entries[id] = {
					...summary,
					sizeBytes
				};
				this.saveIndex();
			}
		} catch {} finally {
			this.indexing = false;
		}
	}
};
/** Ready-made preset: every successful tool result folds to its key parts. */
function presetTemplateSuccess() {
	return {
		id: "preset-tool-ok",
		name: "工具调用成功 → 只保留关键部分",
		enabled: true,
		match: {
			kind: "tool",
			isError: false
		},
		mode: "key",
		auto: false
	};
}
/** Ready-made preset: a failed tool call whose error was already ruled out. */
function presetTemplateFailed() {
	return {
		id: "preset-tool-failed",
		name: "工具失败且已排查 → 只保留关键部分",
		enabled: false,
		match: {
			kind: "tool",
			isError: true
		},
		mode: "key",
		auto: false
	};
}
/** Ready-made preset: assistant prose that became an implementation detail. */
function presetTemplateAssistant() {
	return {
		id: "preset-assistant-key",
		name: "助手消息 → 只保留关键部分",
		enabled: false,
		match: { kind: "assistant" },
		mode: "key",
		auto: false
	};
}
/** The templates the panel offers as one-click presets. */
const PRESET_TEMPLATES = [
	presetTemplateSuccess(),
	presetTemplateFailed(),
	presetTemplateAssistant()
];
//#endregion
//#region src/host/api.ts
/**
* The plugin HTTP surface, shared by both carriers.
*
* Two transports mount the same handler table: the harness webServer service
* when the profile has one (so the panel talks to its own origin and no extra
* port exists), and a private loopback server otherwise (headless profiles and
* the standalone integration tests have no web server at all).
*
* Every response is JSON with either { ok: true, value } or
* { ok: false, error }, so the panel has exactly one failure shape to render.
*
* @module dsh-context-assembler/host/api
*/
/** Path prefix used when the plugin rides the harness web server. */
const API_PREFIX = "/api/context-assembler";
/** Read a request body as text, bounded so a malformed peer stays harmless. */
async function readBody(req, limit = 4194304) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = chunk;
		size += buffer.length;
		if (size > limit) throw new Error("request body too large");
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}
/** Parse a JSON body, treating an empty body as an empty object. */
function parseJson(text) {
	if (text.trim() === "") return {};
	const parsed = JSON.parse(text);
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("request body must be a JSON object");
	return parsed;
}
/**
* Resolve one request.
* @param deps - the assembler service and its resolved configuration.
* @param method - HTTP method.
* @param pathname - pathname relative to API_PREFIX, or absolute for the standalone server.
* @param query - decoded query parameters.
* @param body - already-parsed JSON body, when the request had one.
* @returns the status and JSON body to send.
*/
async function handle(deps, method, pathname, query, body) {
	const path = pathname.startsWith("/api/context-assembler") ? pathname.slice(22) : pathname;
	try {
		if (method === "GET" && (path === "/sessions" || path === "/")) return ok({
			sessions: await deps.assembler.listSessions(),
			defaultSessionId: await deps.assembler.defaultSessionId(),
			config: {
				port: deps.config.port,
				dataDir: deps.config.dataDir,
				exposeTool: deps.config.exposeTool
			}
		});
		if (method === "GET" && path === "/templates") return ok(PRESET_TEMPLATES);
		if (method === "GET" && path === "/tree") {
			const sessionId = query.get("sessionId") ?? await deps.assembler.defaultSessionId();
			if (sessionId === null) return fail(400, "no session is available");
			return ok(await deps.assembler.readTree(sessionId));
		}
		if (method === "GET" && path === "/messages") {
			const sessionId = query.get("sessionId") ?? await deps.assembler.defaultSessionId();
			if (sessionId === null) return fail(400, "no session is available");
			return ok(await deps.assembler.messagesFor(sessionId));
		}
		if (method === "GET" && path === "/presets") {
			const sessionId = query.get("sessionId");
			if (sessionId === null) return fail(400, "sessionId is required");
			return ok(deps.assembler.presetsFor(sessionId));
		}
		if (method === "PUT" && path === "/presets") {
			const sessionId = body["sessionId"];
			if (typeof sessionId !== "string") return fail(400, "sessionId is required");
			const presets = body["presets"];
			if (!Array.isArray(presets)) return fail(400, "presets must be an array");
			return ok(deps.assembler.setPresets(sessionId, presets));
		}
		if (method === "PUT" && path === "/draft") {
			const draftSession = body["sessionId"];
			if (typeof draftSession !== "string") return fail(400, "sessionId is required");
			const draftOps = body["ops"];
			if (!Array.isArray(draftOps)) return fail(400, "ops must be an array");
			return ok(deps.assembler.setDraft(draftSession, draftOps));
		}
		if (method === "POST" && path === "/plan") {
			const request = body;
			if (typeof request.sessionId !== "string") return fail(400, "sessionId is required");
			if (!Array.isArray(request.ops)) return fail(400, "ops must be an array");
			const dryRun = body["dryRun"] === true;
			return ok(await deps.assembler.applyPlan(request, dryRun));
		}
		return fail(404, "unknown api path: " + path);
	} catch (error) {
		return fail(500, error instanceof Error ? error.message : String(error));
	}
}
/** Wrap a successful value. */
function ok(value) {
	return {
		status: 200,
		body: {
			ok: true,
			value
		}
	};
}
/** Wrap a failure. */
function fail(status, error) {
	return {
		status,
		body: {
			ok: false,
			error
		}
	};
}
/** Send one resolved response as JSON. */
function sendJson(res, response) {
	res.writeHead(response.status, {
		"Content-Type": "application/json; charset=utf-8",
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type",
		"Cache-Control": "no-store"
	});
	res.end(JSON.stringify(response.body));
}
/** Adapt the shared handler to a node request/response pair. */
async function nodeHandler(deps, req, res) {
	if (req.method === "OPTIONS") {
		sendJson(res, {
			status: 204,
			body: {}
		});
		return;
	}
	const url = new URL(req.url ?? "/", "http://127.0.0.1");
	let body = {};
	if (req.method === "POST" || req.method === "PUT") try {
		body = parseJson(await readBody(req));
	} catch (error) {
		sendJson(res, fail(400, error instanceof Error ? error.message : String(error)));
		return;
	}
	sendJson(res, await handle(deps, req.method ?? "GET", url.pathname, url.searchParams, body));
}
/**
* Mount the API on the harness web server.
* @param webServer - the webServer service.
* @param deps - assembler and configuration.
* @returns the disposer removing the route.
*/
function registerWebRoute(webServer, deps) {
	return webServer.register({
		kind: "prefix",
		path: API_PREFIX,
		handler: (req, res) => nodeHandler(deps, req, res)
	});
}
/** Bind one private carrier on exactly one port. */
function listenOnce(deps, port) {
	const server = createServer((req, res) => {
		nodeHandler(deps, req, res);
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => {
			server.off("error", reject);
			resolve(server);
		});
	});
}
/**
* Start the private loopback server used when the harness web server is not
* reachable from this plugin's context.
*
* A restart is exactly when a fixed port is least reliable: the outgoing host
* may still hold the socket for a moment while the incoming one boots, and a
* bind failure here used to be silent — the panel simply had nothing to talk to
* and the feature looked like it had been thrown away. Walking a short range
* makes the carrier survive that race; the panel probes the same range.
* @param deps - assembler and configuration.
* @returns the listening server.
* @throws when every port in the range is unavailable.
*/
async function startStandaloneServer(deps) {
	let lastError = /* @__PURE__ */ new Error("no port available");
	for (let offset = 0; offset < 8; offset += 1) try {
		return await listenOnce(deps, deps.config.port + offset);
	} catch (error) {
		lastError = error;
	}
	throw lastError;
}
//#endregion
//#region src/host/tool.ts
/** The model-facing tool name. */
const TOOL_NAME = "context_assembler";
/** Parameter schema, written directly as JSON Schema. */
const PARAMETERS = {
	type: "object",
	additionalProperties: false,
	properties: {
		action: {
			type: "string",
			enum: [
				"tree",
				"set",
				"preset",
				"messages"
			],
			description: "tree reads the context tree with the surface seqs that set targets. set changes assemble modes. preset stores rule presets for this session. messages lists what the model currently receives."
		},
		sessionId: {
			type: "string",
			description: "Target session id. Omit to act on the calling agent own session."
		},
		ops: {
			type: "array",
			description: "Required for set: one entry per context row to change. Take surfaceSeq from a previous tree call.",
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					surfaceSeq: {
						type: "integer",
						description: "The surfaceSeq of the row to change."
					},
					mode: {
						type: "string",
						enum: [
							"full",
							"key",
							"off"
						],
						description: "full sends the recorded events verbatim and also opens a folded region again. key replaces the region with one digest message. off replaces it with a near-empty marker."
					},
					digest: {
						type: "string",
						description: "Digest text used when mode is key. Write the summary yourself: what was learned, and what later steps still need. Omit to keep head and tail lines automatically."
					}
				},
				required: ["surfaceSeq", "mode"]
			}
		},
		applyPresets: {
			type: "boolean",
			description: "For set: run the stored preset rules first. Explicit ops win on conflict."
		},
		dryRun: {
			type: "boolean",
			description: "For set: compute and report the change without writing anything to the session log."
		},
		presets: {
			type: "array",
			description: "Required for preset: the COMPLETE rule list for this session; it replaces the stored list.",
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					id: {
						type: "string",
						description: "Stable rule id; reuse an existing id to edit that rule."
					},
					name: {
						type: "string",
						description: "Human label shown in the panel."
					},
					enabled: {
						type: "boolean",
						description: "Whether the rule participates."
					},
					mode: {
						type: "string",
						enum: ["key", "off"],
						description: "Assemble mode the rule pins on every match."
					},
					template: {
						type: "string",
						description: "Optional digest text for key mode."
					},
					auto: {
						type: "boolean",
						description: "Reserved for automatic application; the panel applies rules explicitly today."
					},
					match: {
						type: "object",
						additionalProperties: false,
						properties: {
							kind: {
								type: "string",
								enum: [
									"system",
									"user",
									"assistant",
									"tool",
									"digest",
									"attempt"
								],
								description: "Row kind the rule matches."
							},
							toolName: {
								type: "string",
								description: "Exact tool name the rule matches."
							},
							isError: {
								type: "boolean",
								description: "Whether the row must be a failed tool call."
							},
							labelPattern: {
								type: "string",
								description: "Regular expression matched against the row label."
							}
						},
						required: []
					}
				},
				required: [
					"name",
					"enabled",
					"mode",
					"match"
				]
			}
		}
	},
	required: ["action"]
};
/** Output schema: the canonical value every call returns. */
const OUTPUT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		action: { type: "string" },
		summary: { type: "string" },
		sessionId: { type: "string" },
		rows: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					id: { type: "string" },
					kind: { type: "string" },
					label: { type: "string" },
					seq: { type: "integer" },
					mode: { type: "string" },
					tokens: { type: "integer" }
				},
				required: [
					"id",
					"kind",
					"label",
					"seq",
					"mode",
					"tokens"
				]
			}
		},
		notes: {
			type: "array",
			items: { type: "string" }
		},
		savedTokens: { type: "integer" },
		visibleTokens: { type: "integer" }
	},
	required: [
		"action",
		"summary",
		"sessionId",
		"rows",
		"notes",
		"savedTokens",
		"visibleTokens"
	]
};
/** The tool description the model reads. */
const DESCRIPTION = [
	"Assemble what this conversation sends to you. The session log keeps every recorded fact; the surface decides which of them you actually read.",
	"Call action=tree to see the context as a tree of rows. Each row carries a surfaceSeq, a kind, an estimated token cost, and its current mode:",
	"full sends the recorded events verbatim, key replaces a region with one digest message, off replaces it with a near-empty marker.",
	"Call action=set with ops to change modes. Prefer key over off: a digest you write keeps the conclusion while dropping the bulk.",
	"Fold a region as soon as its details stop mattering — a tool run whose output you have already absorbed, a sub-task that succeeded, or a failure you have already diagnosed.",
	"Never fold work the current step still depends on; a folded region is only cheap to reopen while it collapses to a single event, so fold whole tool-call groups rather than half of one.",
	"Call action=preset to store rules that the user can apply in the context panel, and action=messages to check what you currently receive."
].join(" ");
/**
* Register the context tool.
* @param tools - the ctx.tools registry.
* @param assembler - the context-assembly service.
* @returns the disposer removing the tool.
*/
function registerTool(tools, assembler) {
	const definition = {
		name: TOOL_NAME,
		description: DESCRIPTION,
		parameters: PARAMETERS,
		output: {
			schema: OUTPUT_SCHEMA,
			render(_args, value) {
				const lines = [value.summary];
				if (value.notes.length > 0) lines.push(...value.notes.map((note) => "· " + note));
				if (value.rows.length > 0) {
					lines.push("");
					for (const row of value.rows) lines.push(row.id + "  [" + row.kind + "]  mode=" + row.mode + "  ~" + row.tokens + " tokens  " + row.label);
				}
				return [{
					type: "text",
					text: lines.join("\n")
				}];
			}
		},
		async execute(args, exec) {
			return run(assembler, args, exec);
		}
	};
	return tools.register(definition);
}
/** Execute one call. */
async function run(assembler, args, exec) {
	const action = typeof args["action"] === "string" ? args["action"] : "tree";
	const sessionId = (typeof args["sessionId"] === "string" ? args["sessionId"] : void 0) ?? exec.agent?.session?.id ?? await assembler.defaultSessionId() ?? void 0;
	if (sessionId === void 0) throw new Error("context_assembler: no session to act on; pass sessionId explicitly");
	if (action === "messages") {
		const messages = await assembler.messagesFor(sessionId);
		const heuristic = messages.reduce((sum, message) => sum + message.tokens, 0);
		const usage = assembler.usageFor(sessionId);
		const tokens = usage?.tokens ?? heuristic;
		return {
			action,
			sessionId,
			rows: [],
			notes: [
				usage === null ? "Size is the sum of the messages on the surface, not a provider-reported figure." : "Size is the provider-reported request pressure: the meter replayed this session log.",
				"The model context window is not visible from here, so this is a count and NOT a fraction of capacity.",
				"Do not read it as nearly full or nearly empty without comparing it to the window separately."
			],
			savedTokens: 0,
			visibleTokens: tokens,
			summary: "The model currently receives " + messages.length + " messages, about " + tokens + " tokens."
		};
	}
	if (action === "preset") {
		const presets = args["presets"];
		if (!Array.isArray(presets)) throw new Error("context_assembler: action=preset requires the complete presets array");
		const stored = assembler.setPresets(sessionId, presets);
		return {
			action,
			sessionId,
			rows: [],
			notes: stored.map((preset) => preset.name + (preset.enabled ? " (启用)" : " (停用)")),
			savedTokens: 0,
			visibleTokens: 0,
			summary: "Stored " + stored.length + " preset rules for this session. The user can apply them from the context panel."
		};
	}
	if (action === "set") {
		const rawOps = args["ops"];
		if (!Array.isArray(rawOps)) throw new Error("context_assembler: action=set requires ops");
		const ops = rawOps.map((entry) => {
			const op = entry;
			const mode = op["mode"];
			if (mode !== "full" && mode !== "key" && mode !== "off") throw new Error("context_assembler: each op needs mode full, key, or off");
			const surfaceSeq = op["surfaceSeq"];
			if (typeof surfaceSeq !== "number") throw new Error("context_assembler: each op needs an integer surfaceSeq from a tree call");
			return {
				surfaceSeq,
				mode,
				digest: typeof op["digest"] === "string" ? op["digest"] : void 0
			};
		});
		const dryRun = args["dryRun"] === true;
		const applyPresets = args["applyPresets"] === true;
		const result = await assembler.applyPlan({
			sessionId,
			ops,
			applyPresets
		}, dryRun);
		const tree = await assembler.readTree(sessionId);
		const rows = compactRows(tree.nodes, 40);
		const summary = (dryRun ? "预览" : "已写入日志") + "：" + result.ops.length + " 个装配操作，" + (result.savedTokens >= 0 ? "节省约 " + result.savedTokens : "增加约 " + -result.savedTokens) + " tokens；当前可见约 " + tree.stats.visibleTokens + " tokens / " + tree.stats.rawTokens + " tokens。";
		return {
			action,
			sessionId,
			rows,
			notes: result.notes,
			savedTokens: result.savedTokens,
			visibleTokens: tree.stats.visibleTokens,
			summary
		};
	}
	const tree = await assembler.readTree(sessionId);
	return {
		action: "tree",
		sessionId,
		rows: compactRows(tree.nodes, 80),
		notes: tree.operations.slice(-5).map((operation) => "最近操作：" + operation.label + "（seq " + operation.startSeq + "–" + operation.endSeq + "）"),
		savedTokens: 0,
		visibleTokens: tree.stats.visibleTokens,
		summary: "上下文共 " + tree.stats.rawTokens + " tokens；当前模型可见 " + tree.stats.visibleTokens + " tokens，已折叠 " + tree.stats.shadowedTokens + " tokens。表层共 " + tree.stats.surfaceNodes + " 个节点，已装配 " + tree.stats.foldedRegions + " 个组装区。"
	};
}
/** One line for the model, bounded so a deep tree stays readable. */
function shorten(text) {
	return text.length > 110 ? text.slice(0, 110) + "…" : text;
}
/** Flatten a row tree into the compact rows the model reads. */
function compactRows(nodes, limit) {
	const rows = [];
	for (const node of flatten(nodes)) {
		if (rows.length >= limit) break;
		rows.push({
			id: node.surfaceSeq === null ? node.id : "s" + node.surfaceSeq,
			kind: node.kind,
			label: shorten(node.hint === void 0 ? node.label : node.label + " — " + node.hint),
			seq: node.surfaceSeq ?? -1,
			mode: node.selectable ? node.mode : node.mode + "(不可切换)",
			tokens: node.tokens
		});
	}
	return rows;
}
//#endregion
//#region src/index.ts
/** Cordis plugin name. */
const name = "context-assembler";
/**
* The one service this plugin cannot work without.
*
* Cordis refuses to read a service property from a context that never declared
* it — "cannot get property sessions without inject" — and that refusal happens
* at plugin-apply time, so an undeclared dependency is a boot failure rather
* than a degraded feature. `sessions` is mounted by dsh-base in every profile,
* so requiring it costs nothing; every other service (tools, webServer) is read
* through the optional accessor below and simply changes what activates.
*/
const inject = ["sessions", "tools"];
/**
* Read an optional service without declaring it in `inject`.
*
* Cordis exposes `ctx.get(name)` for exactly this: a missing service yields
* undefined instead of the inject refusal a property read would raise.
* @param ctx - the plugin context.
* @param name - service name.
* @returns the service, or undefined when the profile does not mount it.
*/
function optionalService(ctx, name) {
	const direct = ctx.get;
	if (typeof direct === "function") try {
		const value = direct.call(ctx, name);
		if (value !== void 0) return value;
	} catch {}
	const reflect = ctx.reflect;
	if (reflect !== void 0 && typeof reflect.get === "function") try {
		return reflect.get(name, false);
	} catch {
		return;
	}
}
/**
* Mount the host half.
* @param ctx - the plugin cordis context, already holding the sessions service.
* @param config - optional plugin configuration from the profile row.
*/
function apply(ctx, config) {
	const resolved = resolveConfig(config);
	const sessions = ctx.sessions;
	if (sessions === void 0) {
		ctx.logger?.warn("[context-assembler] sessions 服务不可用，插件未激活");
		return;
	}
	const assembler = new ContextAssembler(sessions, resolved, () => optionalService(ctx, "sessionPersistence"), (message) => ctx.logger?.warn?.(message), () => optionalService(ctx, "tokenMeter"));
	assembler.warmIndex();
	mountApi(ctx, assembler, resolved);
	if (resolved.exposeTool) mountTool(ctx, assembler);
	mountAutoPresets(ctx, assembler);
}
/** Mount the HTTP surface on whichever carrier this profile has. */
function mountApi(ctx, assembler, config) {
	const deps = {
		assembler,
		config
	};
	const webServer = optionalService(ctx, "webServer");
	if (webServer !== void 0 && typeof webServer.register === "function") try {
		const dispose = registerWebRoute(webServer, deps);
		ctx.effect?.(() => () => dispose(), "context-assembler: web route");
		ctx.logger?.info?.("[context-assembler] 已挂载到 /api/context-assembler");
		return;
	} catch (error) {
		ctx.logger?.warn?.("[context-assembler] 挂载 webServer 路由失败，改用本地端口：" + String(error));
	}
	startStandaloneServer(deps).then((server) => {
		ctx.effect?.(() => () => {
			server.close();
		}, "context-assembler: standalone server");
		ctx.logger?.info?.("[context-assembler] 本地 API http://127.0.0.1:" + config.port);
	}).catch((error) => {
		ctx.logger?.warn?.("[context-assembler] 本地 API 端口启动失败：" + String(error));
	});
}
/** Register the model-facing context tool when a tool registry exists. */
function mountTool(ctx, assembler) {
	const tools = optionalService(ctx, "tools");
	if (tools === void 0 || typeof tools.register !== "function") return;
	try {
		const dispose = registerTool(tools, assembler);
		ctx.effect?.(() => () => dispose(), "context-assembler: context_assembler tool");
	} catch (error) {
		ctx.logger?.warn?.("[context-assembler] 注册 context_assembler 工具失败：" + String(error));
	}
}
/**
* Apply presets marked auto whenever a turn closes.
*
* Opt-in per rule and off for every shipped template: silently rewriting what
* the model reads is a strong action, so the profile row has to ask for it.
*/
function mountAutoPresets(ctx, assembler) {
	if (typeof ctx.on !== "function") return;
	ctx.on("session/event", (...args) => {
		const event = args[1];
		if (event === void 0 || event.type !== "turn/end") return;
		const session = args[0];
		if (session === void 0 || typeof session.id !== "string") return;
		if (!assembler.presetsFor(session.id).some((rule) => rule.enabled && rule.auto === true)) return;
		assembler.applyPlan({
			sessionId: session.id,
			ops: [],
			applyPresets: true
		}, false).catch((error) => {
			ctx.logger?.warn?.("[context-assembler] 自动预设失败：" + String(error));
		});
	});
}
//#endregion
export { apply, inject, name };
