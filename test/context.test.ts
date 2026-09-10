/**
 * Integration tests for the assembled-context host half.
 *
 * These run against the REAL harness session: a live Session instance from
 * @deepseek-ai/dsh-session owns the surface fold, so a passing test means the
 * plugin compiled operations the harness actually accepts and that
 * deriveMessages() really changed. A fake session would only prove the plugin
 * agrees with itself.
 *
 * Run with: node --test test/
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { Session } from '@deepseek-ai/dsh-session'
import { estimateTokens, foldSurface, messageText, projectEvent } from '../src/host/surface.ts'
import { buildContextTree } from '../src/host/tree.ts'
import { compilePlan, DEFAULT_DIGEST_OPTIONS } from '../src/host/planner.ts'
import { ContextAssembler, resolveConfig, type SessionLike, type SessionStoreLike } from '../src/host/service.ts'
import { handle } from '../src/host/api.ts'

/** Build a session that looks like one real turn with one tool call. */
function sampleSession(id = 'session-test'): Session {
  const session = Session.create(id)
  session.append('turn/start', { turn: 1 })
  session.append('system/message', {
    turn: 1,
    step: 1,
    message: { id: 's', role: 'system', content: [{ type: 'text', text: 'SYSTEM PROMPT' }], source: { kind: 'plugin', plugin: 'system-prompt' } },
  }, { surfaceOp: 'append' })
  // Real order: the loop opens the step before it claims the queued prompt, so
  // the user message belongs INSIDE step 1.1. Emitting it first would put it at
  // turn level and split the step in two, which no real session does.
  session.append('step/start', { turn: 1, step: 1 })
  session.append('user/message', {
    id: 'u1', role: 'user', content: [{ type: 'text', text: 'please list the files' }], source: { kind: 'user' },
  }, { surfaceOp: 'append' })
  session.append('tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{"command":"ls"}' })
  const body = Array.from({ length: 80 }, (_value, index) => 'file-' + index + '.txt').join('\n')
  const assistant = {
    id: 'a1', role: 'assistant',
    content: [{ type: 'text', text: 'Listing the directory.' }, { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"ls"}' }],
    source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
  }
  session.append('assistant/message', { turn: 1, step: 1, message: assistant, stream: [] }, { surfaceOp: 'append' })
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: { id: 't1', role: 'user', content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: body }] }], source: { kind: 'tool', callId: 'call-1' } },
  }, { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: { id: 'a2', role: 'assistant', content: [{ type: 'text', text: 'There are 80 files.' }], source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' } },
    stream: [],
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'stop' } })
  return session
}

/** Wrap one live session in the store shape the service consumes. */
function storeOf(sessions: Session[]): SessionStoreLike {
  return {
    list: () => sessions as unknown as SessionLike[],
    get: (id: string) => sessions.find((session) => session.id === id) as unknown as SessionLike | undefined,
  };
}

test('foldSurface tracks append and replace nodes', () => {
  const events = [
    { type: 'user/message', seq: 0, time: 0, data: {}, surfaceOp: 'append' },
    { type: 'user/message', seq: 1, time: 0, data: {}, surfaceOp: 'append' },
    { type: 'assistant/message', seq: 2, time: 0, data: {}, surfaceOp: 'append' },
    { type: 'user/message', seq: 3, time: 0, data: {}, surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 }, sourceEventSeqs: [1, 2] },
  ]
  const fold = foldSurface(events)
  assert.deepEqual(fold.nodes, [0, 3])
  assert.deepEqual(fold.shadowed.get(3), [1, 2])
});

test('estimateTokens separates CJK from ASCII', () => {
  assert.ok(estimateTokens('中文中文') > estimateTokens('abcd'));
  assert.equal(estimateTokens(''), 0);
});

test('buildContextTree groups turns, steps, tools, and keeps the system head', () => {
  const session = sampleSession()
  const tree = buildContextTree({ sessionId: session.id, title: 't', events: session.snapshotEvents() as never })
  assert.ok(tree.nodes.length >= 1)
  const turn = tree.nodes.find((node) => node.kind === 'turn')
  assert.ok(turn !== undefined, 'a turn container exists')
  assert.ok((turn.children ?? []).some((node) => node.kind === 'step'), 'a step container exists')
  const rows: typeof tree.nodes = []
  const walk = (nodes: typeof tree.nodes): void => {
    for (const node of nodes) {
      rows.push(node)
      if (node.children !== undefined) walk(node.children)
    }
  }
  walk(turn.children ?? [])
  const kinds = rows.map((node) => node.kind)
  assert.ok(kinds.includes('assistant'))
  assert.ok(kinds.includes('tool'))
  const tool = rows.find((node) => node.kind === 'tool')
  assert.equal(tool?.toolName, 'bash')
  assert.ok(tool !== undefined && tool.tokens > 50, 'the tool result carries real tokens')
  const seqOrder = rows.map((node) => node.surfaceSeq).filter((seq): seq is number => seq !== null)
  assert.deepEqual(seqOrder, [...seqOrder].sort((a, b) => a - b), 'rows stay in surface order')
  assert.ok(tree.stats.rawTokens > tree.stats.visibleTokens - 1)
});

test('compilePlan folds one tool result without breaking tool pairing', () => {
  const session = sampleSession()
  const events = session.snapshotEvents() as never[]
  const fold = foldSurface(events as never)
  const toolSeq = fold.nodes.find((seq) => (events[seq] as { type: string }).type === 'tool/result')
  assert.ok(toolSeq !== undefined)
  const compiled = compilePlan(events as never, [{ surfaceSeq: toolSeq as number, mode: 'key' }], DEFAULT_DIGEST_OPTIONS)
  assert.equal(compiled.instructions.length, 1)
  assert.equal(compiled.instructions[0]?.type, 'tool/result')
  const text = compiled.instructions[0]?.op.text ?? ''
  assert.ok(text.includes('assembled:key'))
  assert.ok(text.includes('省略'), 'the digest counts what it dropped')
  const digestTokens = compiled.instructions[0]?.op.tokens ?? 0
  const before = compiled.instructions[0]?.op.previousTokens ?? 0
  assert.ok(digestTokens < before / 2, 'the digest is much smaller than the result')
});

test('compilePlan never covers the protected system head', () => {
  const session = sampleSession()
  const events = session.snapshotEvents() as never[]
  const fold = foldSurface(events as never)
  const compiled = compilePlan(events as never, fold.nodes.map((seq) => ({ surfaceSeq: seq, mode: 'off' as const })), DEFAULT_DIGEST_OPTIONS)
  for (const instruction of compiled.instructions) {
    assert.notEqual(instruction.op.startSeq, fold.nodes[0]);
  }
});

test('compilePlan widens a fold that would orphan a tool result', () => {
  const session = sampleSession()
  const events = session.snapshotEvents() as never[]
  const fold = foldSurface(events as never)
  const assistantSeq = fold.nodes.find((seq) => (events[seq] as { type: string }).type === 'assistant/message')
  assert.ok(assistantSeq !== undefined)
  const compiled = compilePlan(events as never, [{ surfaceSeq: assistantSeq as number, mode: 'off' }], DEFAULT_DIGEST_OPTIONS)
  const op = compiled.instructions[0]?.op
  assert.ok(op !== undefined)
  const types = op.shadowedSeqs.map((seq) => (events[seq] as { type: string }).type)
  assert.ok(types.includes('tool/result'), 'the matching tool result travels with its call')
});

test('ContextAssembler folds and then opens a region again', async () => {
  const session = sampleSession()
  const assembler = new ContextAssembler(storeOf([session]), resolveConfig({ dataDir: process.cwd() + '/scratch-test-data' }))
  const before = session.deriveMessages().length
  const tree = await assembler.readTree(session.id)
  const rows: Array<{ surfaceSeq: number; mode: string }> = []
  const walk = (nodes: typeof tree.nodes): void => {
    for (const node of nodes) {
      if (node.kind === 'tool' && node.surfaceSeq !== null && node.selectable) rows.push({ surfaceSeq: node.surfaceSeq, mode: 'key' });
      if (node.children !== undefined) walk(node.children);
    }
  };
  walk(tree.nodes)
  assert.equal(rows.length, 1)
  const applied = await assembler.applyPlan({ sessionId: session.id, ops: rows as never }, false)
  assert.equal(applied.ops.length, 1)
  const after = session.deriveMessages()
  assert.equal(after.length, before, 'a replacement keeps the message count intact')
  assert.ok(applied.savedTokens > 0)

  const folded = await assembler.readTree(session.id)
  const digest = folded.nodes
  const findDigest = (nodes: typeof folded.nodes): { surfaceSeq: number | null } | null => {
    for (const node of nodes) {
      if (node.state === 'digest' && node.surfaceSeq !== null) return node;
      if (node.children !== undefined) {
        const inner = findDigest(node.children);
        if (inner !== null) return inner;
      }
    }
    return null;
  };
  const digestNode = findDigest(digest);
  assert.ok(digestNode !== null, 'the fold shows up as a digest row')
  const opened = await assembler.applyPlan({
    sessionId: session.id,
    ops: [{ surfaceSeq: digestNode?.surfaceSeq as number, mode: 'full' }],
  }, false)
  assert.equal(opened.ops.length, 1)
  assert.equal(opened.ops[0]?.mode, 'full')
  const reopened = session.deriveMessages();
  const restoredText = reopened
    .map((message) => messageText({ role: message.role, content: message.content as never }))
    .join('\n');
  assert.ok(restoredText.includes('file-0.txt'), 'the verbatim tool result came back');
  assert.ok(restoredText.includes('file-79.txt'), 'and it came back whole, not as a digest');
  assert.ok(!restoredText.includes('省略'), 'no digest marker survives the reopen');
});

test('applyPlan refuses to invent work when nothing changed', async () => {
  const session = sampleSession()
  const assembler = new ContextAssembler(storeOf([session]), resolveConfig({ dataDir: process.cwd() + '/scratch-test-data' }))
  const result = await assembler.applyPlan({ sessionId: session.id, ops: [{ surfaceSeq: 1, mode: 'full' }] }, true)
  assert.equal(result.ops.length, 0)
  assert.equal(result.dryRun, true)
});

test('a folded region is priced at its digest, not at everything it replaced', async () => {
  const session = sampleSession();
  const assembler = new ContextAssembler(storeOf([session]), resolveConfig({ dataDir: process.cwd() + '/scratch-test-data' }));
  const flat = async () => {
    const out: Array<{ kind: string; state: string; tokens: number; surfaceSeq: number | null; selectable: boolean; children?: unknown }> = [];
    const visit = (nodes: readonly unknown[]): void => {
      for (const raw of nodes) {
        const node = raw as { kind: string; state: string; tokens: number; surfaceSeq: number | null; selectable: boolean; children?: readonly unknown[] };
        out.push(node);
        if (node.children !== undefined) visit(node.children);
      }
    };
    visit((await assembler.readTree(session.id)).nodes);
    return out;
  };
  const toolRow = (await flat()).find((node) => node.kind === 'tool');
  assert.ok(toolRow !== undefined && toolRow.surfaceSeq !== null);
  const originalTokens = toolRow.tokens;
  await assembler.applyPlan({ sessionId: session.id, ops: [{ surfaceSeq: toolRow.surfaceSeq, mode: 'key' }] }, false);
  const digest = (await flat()).find((node) => node.state === 'digest');
  assert.ok(digest !== undefined, 'the fold is visible as a digest row');
  assert.ok(
    digest.tokens < originalTokens,
    'the digest row reports its own cost, not the region it shadowed (got ' + digest.tokens + ' vs ' + originalTokens + ')',
  );
  const stats = (await assembler.readTree(session.id)).stats;
  const derived = session.deriveMessages()
    .map((message) => estimateTokens(messageText({ role: message.role, content: message.content as never })))
    .reduce((sum, value) => sum + value, 0);
  assert.ok(Math.abs(stats.visibleTokens - derived) < originalTokens / 2, 'stats stay close to the derived history cost');
});
test('containers carry a one-line gist instead of a bare ordinal', () => {
  const session = sampleSession();
  const tree = buildContextTree({ sessionId: session.id, title: 't', events: session.snapshotEvents() as never });
  const turn = tree.nodes.find((node) => node.kind === 'turn');
  assert.ok(turn !== undefined);
  assert.ok(turn.hint !== undefined, 'the turn explains itself');
  const steps = (turn.children ?? []).filter((node) => node.kind === 'step');
  assert.equal(steps.length, 1, 'one step stays one container');
  assert.equal(steps[0]?.hint, 'please list the files', 'the gist is the first thing said in the step');
  assert.notEqual(steps[0]?.hint, 'SYSTEM PROMPT', 'the rendered system prompt never labels a step');
});

test('a tool-only step names the tool instead of dumping its arguments', () => {
  const session = Session.create('gist-tool');
  session.append('turn/start', { turn: 1 });
  session.append('step/start', { turn: 1, step: 1 });
  session.append('system/message', {
    turn: 1,
    step: 1,
    message: { id: 's', role: 'system', content: [{ type: 'text', text: 'SYSTEM PROMPT' }], source: { kind: 'plugin', plugin: 'system-prompt' } },
  }, { surfaceOp: 'append' });
  session.append('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' });
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: {
      id: 'a',
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"ls"}' }],
      source: { kind: 'model', provider: 'p', model: 'm' },
    },
    stream: [],
  }, { surfaceOp: 'append' });
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: { id: 't', role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'total 8\ndrwxr-xr-x 5 user 160 Jan 1 00:00 src' }] }], source: { kind: 'tool', callId: 'c1' } },
  }, { surfaceOp: 'append' });
  session.append('step/end', { turn: 1, step: 1 });
  session.append('turn/end', { turn: 1, reason: { kind: 'stop' } });
  const tree = buildContextTree({ sessionId: session.id, title: 't', events: session.snapshotEvents() as never });
  const step = (tree.nodes.find((node) => node.kind === 'turn')?.children ?? []).find((node) => node.kind === 'step');
  assert.ok(step !== undefined);
  assert.ok(step.hint !== undefined, 'a tool-only step still explains itself');
  assert.ok(!step.hint.includes('command'), 'the gist never dumps raw arguments: ' + step.hint);
  assert.ok(step.hint.startsWith('工具 bash'), 'the gist names the tool: ' + step.hint);
});
/** Minimal session shape for the lineage tests; they never touch the log. */
function lineageSession(id: string, parent?: string): SessionLike {
  return {
    id,
    seq: 0,
    header: { id, createdAt: 0, parentSession: parent },
    snapshotEvents: () => [],
    deriveMessages: () => [],
    append: () => undefined,
  };
}

/** Store over plain session-like objects. */
function fakeStore(sessions: SessionLike[]): SessionStoreLike {
  return {
    list: () => sessions,
    get: (id: string) => sessions.find((session) => session.id === id),
  };
}

let dataDirCounter = 0;

/**
 * A private data directory per test AND per run.
 *
 * The run-unique part is load-bearing: these tables record an explicit empty
 * entry when a plan is cleared, and an explicit empty entry is exactly what
 * stops a session from inheriting its parent's plan. A directory reused between
 * runs would therefore carry that empty entry into the next run and make the
 * inheritance assertions fail for the wrong reason.
 */
function tempDataDir(): string {
  dataDirCounter += 1;
  return process.cwd() + '/scratch-test-data/run-' + String(process.pid) + '-' + String(Date.now()) + '-' + String(dataDirCounter);
}

test('a folded tool result is recognised as this plugin work', async () => {
  const session = sampleSession();
  const assembler = new ContextAssembler(storeOf([session]), resolveConfig({ dataDir: tempDataDir() }));
  const rows: ContextNodeView[] = [];
  const walk = (nodes: ContextNodeView[]): void => {
    for (const node of nodes) {
      rows.push(node);
      if (node.children !== undefined) walk(node.children);
    }
  };
  walk((await assembler.readTree(session.id)).nodes);
  const tool = rows.find((node) => node.kind === 'tool' && node.surfaceSeq !== null);
  assert.ok(tool !== undefined && tool.surfaceSeq !== null);
  await assembler.applyPlan({ sessionId: session.id, ops: [{ surfaceSeq: tool.surfaceSeq, mode: 'off' }] }, false);

  const after = await assembler.readTree(session.id);
  assert.equal(after.stats.foldedRegions, 1, 'the fold is counted');
  assert.equal(after.operations.length, 1, 'and appears in the operation log');
  const digestRows: ContextNodeView[] = [];
  const walkDigest = (nodes: ContextNodeView[]): void => {
    for (const node of nodes) {
      if (node.state === 'digest') digestRows.push(node);
      if (node.children !== undefined) walkDigest(node.children);
    }
  };
  walkDigest(after.nodes);
  assert.equal(digestRows.length, 1);
  assert.equal(digestRows[0]?.mode, 'off', 'an off fold reads back as off, not as key');
});

test('drafts and presets follow the conversation across a fork', () => {
  const parent = lineageSession('parent-session');
  const child = lineageSession('child-session', 'parent-session');
  const assembler = new ContextAssembler(fakeStore([parent, child]), resolveConfig({ dataDir: tempDataDir() }));

  assembler.setDraft('parent-session', [{ surfaceSeq: 12, mode: 'key' }]);
  assert.deepEqual(assembler.draftFor('child-session'), [{ surfaceSeq: 12, mode: 'key' }], 'the fork inherits the unapplied plan');
  assert.deepEqual(assembler.draftFor('parent-session'), [{ surfaceSeq: 12, mode: 'key' }]);

  assembler.setDraft('child-session', []);
  assert.deepEqual(assembler.draftFor('child-session'), [], 'an explicit empty plan stops the inheritance');

  assembler.setPresets('parent-session', [{ id: 'r1', name: 'rule', enabled: true, mode: 'key', match: { kind: 'tool' } }]);
  assert.equal(assembler.presetsFor('child-session').length, 1, 'the fork inherits the presets');
  assert.equal(assembler.presetsFor('unrelated').length, 0);
});

test('a saved plan outlives the service instance', () => {
  const dir = tempDataDir();
  const first = new ContextAssembler(fakeStore([lineageSession('s1')]), resolveConfig({ dataDir: dir }));
  first.setDraft('s1', [{ surfaceSeq: 7, mode: 'off', digest: 'kept' }]);
  const second = new ContextAssembler(fakeStore([lineageSession('s1')]), resolveConfig({ dataDir: dir }));
  assert.deepEqual(second.draftFor('s1'), [{ surfaceSeq: 7, mode: 'off', digest: 'kept' }]);
});
test('the draft route round-trips through the HTTP handler', async () => {
  const session = lineageSession('route-session');
  const config = resolveConfig({ dataDir: tempDataDir() });
  const assembler = new ContextAssembler(fakeStore([session]), config);
  const deps = { assembler, config };

  const saved = await handle(deps, 'PUT', '/api/context-assembler/draft', new URLSearchParams(), {
    sessionId: 'route-session',
    ops: [{ surfaceSeq: 3, mode: 'key', digest: 'kept across a restart' }],
  });
  assert.equal(saved.status, 200);
  assert.deepEqual((saved.body as { value: unknown }).value, [{ surfaceSeq: 3, mode: 'key', digest: 'kept across a restart' }]);

  const bad = await handle(deps, 'PUT', '/api/context-assembler/draft', new URLSearchParams(), { sessionId: 'route-session' });
  assert.equal(bad.status, 400);

  const tree = await handle(deps, 'GET', '/api/context-assembler/tree', new URLSearchParams({ sessionId: 'route-session' }), {});
  assert.equal(tree.status, 200);
  const value = (tree.body as { value: { draft: unknown } }).value;
  assert.deepEqual(value.draft, [{ surfaceSeq: 3, mode: 'key', digest: 'kept across a restart' }]);
});
test('a fold is grouped where its content sat, not where it was written', () => {
  const events = [
    { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 0, data: { turn: 1, step: 1 } },
    { type: 'user/message', seq: 2, time: 0, data: { id: 'u1', role: 'user', content: [{ type: 'text', text: 'turn one question' }], source: { kind: 'user' } }, surfaceOp: 'append' },
    { type: 'assistant/message', seq: 3, time: 0, data: { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'turn one answer' }], source: { kind: 'model', provider: 'p', model: 'm' } }, stream: [] }, surfaceOp: 'append' },
    { type: 'step/end', seq: 4, time: 0, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 5, time: 0, data: { turn: 1, reason: { kind: 'stop' } } },
    { type: 'turn/start', seq: 6, time: 0, data: { turn: 2 } },
    { type: 'step/start', seq: 7, time: 0, data: { turn: 2, step: 1 } },
    { type: 'user/message', seq: 8, time: 0, data: { id: 'u2', role: 'user', content: [{ type: 'text', text: 'turn two question' }], source: { kind: 'user' } }, surfaceOp: 'append' },
    { type: 'assistant/message', seq: 9, time: 0, data: { turn: 2, step: 1, message: { id: 'a2', role: 'assistant', content: [{ type: 'text', text: 'turn two answer' }], source: { kind: 'model', provider: 'p', model: 'm' } }, stream: [] }, surfaceOp: 'append' },
    { type: 'turn/end', seq: 10, time: 0, data: { turn: 2, reason: { kind: 'stop' } } },
    {
      type: 'user/message', seq: 11, time: 0,
      data: { id: 'd1', role: 'user', content: [{ type: 'text', text: '⟨assembled:key items=2⟩ digest of turn one' }], source: { kind: 'plugin', plugin: '@dsh-external/dsh-client-plugin-context-assembler', form: 'notice', summary: 'assembled:key items=2 tokens=9' } },
      surfaceOp: { op: 'replace', startSeq: 2, endSeq: 3 },
      sourceEventSeqs: [2, 3],
    },
  ];
  const tree = buildContextTree({ sessionId: 'ordering', title: 't', events: events as never });
  const turns = tree.nodes.filter((node) => node.kind === 'turn');
  const labels = turns.map((node) => node.label);
  assert.deepEqual(labels, ['第 1 轮', '第 2 轮'], 'turns stay chronological and unique: ' + labels.join(','));
  const turnOne = turns[0];
  const rows: typeof tree.nodes = [];
  const walk = (nodes: typeof tree.nodes): void => {
    for (const node of nodes) {
      rows.push(node);
      if (node.children !== undefined) walk(node.children);
    }
  };
  walk(turnOne?.children ?? []);
  const digest = rows.find((node) => node.state === 'digest');
  assert.ok(digest !== undefined, 'the fold is present');
  assert.equal(digest?.turn, 1, 'the fold is filed under the turn it replaced, not the turn it was written in');
  const turnTwo = turns[1];
  const twoRows: typeof tree.nodes = [];
  const walkTwo = (nodes: typeof tree.nodes): void => {
    for (const node of nodes) {
      twoRows.push(node);
      if (node.children !== undefined) walkTwo(node.children);
    }
  };
  walkTwo(turnTwo?.children ?? []);
  assert.equal(twoRows.some((node) => node.state === 'digest'), false, 'turn two has no stray fold');
});
test('a stored conversation can be read without opening it', async () => {
  const live = sampleSession();
  const stored = sampleSession();
  const storedEvents = stored.snapshotEvents();
  const persistence = {
    list: async () => [{ header: { id: 'stored-1', createdAt: 1 }, eventCount: storedEvents.length }],
    open: async () => ({ read: async () => ({ events: storedEvents }), close: () => undefined }),
  };
  const assembler = new ContextAssembler(
    storeOf([live]),
    resolveConfig({ dataDir: tempDataDir() }),
    () => persistence as never,
  );

  const rows = await assembler.listSessions();
  const cold = rows.find((row) => row.id === 'stored-1');
  assert.ok(cold !== undefined, 'a stored session shows up in the picker');
  assert.equal(cold?.cold, true);
  assert.equal(rows.some((row) => row.cold === false), true, 'live sessions keep winning the default');
  assert.equal(await assembler.defaultSessionId(), live.id, 'the default stays a live session');

  const tree = await assembler.readTree('stored-1');
  assert.equal(tree.readOnly, true, 'the tree says it cannot be edited from here');
  assert.ok(tree.nodes.length > 0, 'the stored log produces a tree');
  assert.ok((await assembler.messagesFor('stored-1')).length > 0, 'and a derived message list');

  await assert.rejects(
    async () => { await assembler.applyPlan({ sessionId: 'stored-1', ops: [] }, false) },
    /历史会话/,
    'editing a stored session fails with an explanation rather than a crash',
  );
});

test('a missing persistence backend degrades to live sessions only', async () => {
  const live = sampleSession();
  const assembler = new ContextAssembler(storeOf([live]), resolveConfig({ dataDir: tempDataDir() }), () => undefined);
  const rows = await assembler.listSessions();
  assert.equal(rows.length, 1);
  await assert.rejects(async () => { await assembler.readTree('nope') }, /持久化记录/);
});
