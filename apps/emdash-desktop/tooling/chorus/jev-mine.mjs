// Mines Chorus interaction traces for Jev router edge cases: which fan-out decisions fell back to
// Claude and why, which were most uncertain, and what each purpose costs in latency. Read-only.
//
//   node tooling/chorus/jev-mine.mjs [dataDir] [--top 25]
//
// dataDir defaults to %APPDATA%\chorus\chorus (Windows) or ~/.config/chorus/chorus. Traces exist
// only with Settings → Chorus → "Keep diagnostic history" on. Utterances are printed, so treat
// the output like the trace file itself.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const topIndex = args.indexOf('--top');
const top = topIndex >= 0 ? Number(args[topIndex + 1]) : 25;
const positional = args.filter((arg, i) => !arg.startsWith('--') && args[i - 1] !== '--top');
const dataDir =
  positional[0] ??
  (process.env.APPDATA
    ? join(process.env.APPDATA, 'chorus', 'chorus')
    : join(homedir(), '.config', 'chorus', 'chorus'));

const events = readFileSync(join(dataDir, 'interaction-trace.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });

const utterances = new Map();
for (const event of events) {
  // Voice utterances are traced as the final transcript, typed ones as the capture.
  const spoken = event.kind === 'stt-final' || event.kind === 'capture';
  if (spoken && event.text && !utterances.has(event.interactionId)) {
    utterances.set(event.interactionId, event.text);
  }
}

const jev = events.filter((event) => event.kind === 'jev');
if (jev.length === 0) {
  console.log(`No 'jev' trace events in ${dataDir}. Is diagnostic history on?`);
  process.exit(0);
}

const quantile = (values, p) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : NaN;
};
const countBy = (items, key) => {
  const counts = new Map();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]);
};

// "focus (0.91) | focus=0.91 | status=0.05" → { focus: 0.91, status: 0.05 }
function probabilities(summary) {
  if (typeof summary !== 'string') return {};
  return Object.fromEntries(
    summary
      .split(' | ')
      .slice(1)
      .map((part) => {
        const at = part.lastIndexOf('=');
        return [part.slice(0, at), Number(part.slice(at + 1))];
      })
  );
}

function entropy(probs) {
  const values = Object.values(probs).filter((value) => value > 0);
  if (values.length <= 1) return 0;
  const residual = Math.max(0, 1 - values.reduce((sum, value) => sum + value, 0));
  const all = residual > 0.001 ? [...values, residual] : values;
  const h = -all.reduce((sum, value) => sum + value * Math.log(value), 0);
  return h / Math.log(all.length);
}

console.log(`${jev.length} Jev events from ${dataDir}\n`);

console.log('Latency and outcome by purpose:');
for (const [purpose] of countBy(jev, (event) => event.detail?.purpose ?? '?')) {
  const group = jev.filter((event) => (event.detail?.purpose ?? '?') === purpose);
  const ms = group.map((event) => event.detail?.ms ?? event.detail?.roundTripMs);
  const cost = group.reduce((sum, event) => sum + (event.detail?.costUsd ?? 0), 0);
  const statuses = countBy(group, (event) => event.detail?.status ?? '?')
    .map(([status, count]) => `${status}=${count}`)
    .join(' ');
  console.log(
    `  ${purpose.padEnd(16)} n=${String(group.length).padStart(4)}  p50=${quantile(ms, 0.5)}ms  p90=${quantile(ms, 0.9)}ms  cost=$${cost.toFixed(5)}  ${statuses}`
  );
}

const routes = jev.filter(
  (event) => event.detail?.purpose === 'route' && event.detail?.status === 'answered'
);
console.log('\nRouter decisions:');
for (const [decision, count] of countBy(routes, (event) => event.detail.decision)) {
  console.log(`  ${String(decision).padEnd(10)} ${count}`);
}
console.log('\nWhy the router handed utterances to Claude:');
for (const [reason, count] of countBy(
  routes.filter((event) => event.detail.decision === 'llm'),
  (event) => event.detail.reason
)) {
  console.log(`  ${String(reason).padEnd(28)} ${count}`);
}
console.log('\nSkipped or failed before a decision:');
for (const [reason, count] of countBy(
  jev.filter((event) => event.detail?.purpose === 'route' && event.detail?.status !== 'answered'),
  (event) => `${event.detail?.status}:${event.detail?.reason}`
)) {
  console.log(`  ${String(reason).padEnd(28)} ${count}`);
}

const ranked = routes
  .map((event) => {
    const intent = probabilities(event.detail.jev_intent);
    const target = probabilities(event.detail.jev_target);
    const action = probabilities(event.detail.jev_action);
    return {
      event,
      score: Math.max(entropy(intent), entropy(target), entropy(action)),
    };
  })
  .sort((a, b) => b.score - a.score)
  .slice(0, top);

console.log(`\nMost uncertain routing decisions (top ${ranked.length}; eval candidates):`);
for (const { event, score } of ranked) {
  const detail = event.detail;
  const text = utterances.get(event.interactionId) ?? '(utterance not traced)';
  console.log(
    `\n  [${score.toFixed(2)}] ${event.at}  ${detail.decision}${detail.reason ? ` (${detail.reason})` : ''}${detail.action ? ` → ${detail.action}` : ''}`
  );
  console.log(`    "${text.slice(0, 160)}"`);
  for (const id of ['jev_addressee', 'jev_intent', 'jev_target', 'jev_action']) {
    if (detail[id] !== undefined) console.log(`    ${id.slice(4).padEnd(10)} ${detail[id]}`);
  }
}

const completions = jev.filter((event) => event.detail?.purpose === 'completion');
if (completions.length > 0) {
  console.log('\nCompletion gate verdicts:');
  const verdicts = completions.flatMap((event) =>
    String(event.detail?.verdicts ?? '')
      .split(', ')
      .filter(Boolean)
  );
  for (const [verdict, count] of countBy(verdicts, (verdict) => verdict)) {
    console.log(`  ${verdict.padEnd(34)} ${count}`);
  }
}
