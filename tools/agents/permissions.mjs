// Auto is a decision, not an approval dialog. An unavailable judge is not a denial: return that distinction to the
// operating model without running the tool. Pi supplies its signed-in model call.
import timers from 'node:timers/promises';

export const JUDGE = `You decide whether a coding agent may take a step without asking the person directing it. The agent works in the Ephemeris studio's workspace, on films whose timelines and code are each kept in the film's history (a version of the film each time they change). Answer with one word.
ALLOW: the step plainly serves what the director asked, and anything it changes is inside the workspace and can be brought back from a film's history (reading, building, rendering, running the project's tools and tests, editing or creating a film's code or timelines).
DENY: it could delete or overwrite what the history cannot bring back (a film's media/, assets/, instruments/ or history/, anything outside a film), reaches outside the workspace (other folders, system settings, installing software, sending anything over the network), stops or starts services, pushes or publishes, spends money, is not what the director asked for — or you cannot tell.`;

export const judgeInput = (root, message, name, input) => `The director's latest message:\n${message ?? '(none)'}\n\nThe workspace: ${root}\nThe step: ${name} ${JSON.stringify(input)}`;

/** Pi's tool gate result: undefined permits execution; a blocked call becomes a model-visible tool error. */
export async function judgeTool(evaluate, signal) {
  const stopped = () => ({ block: true, reason: 'Stopped.' });
  // One initial evaluation and up to ten retries. Retry only failures, never an actual denial.
  for (let retry = 0; retry <= 10; retry++) {
    if (signal?.aborted) return stopped();
    try {
      const verdict = (await evaluate()).trim().toUpperCase();
      if (signal?.aborted) return stopped();
      if (verdict === 'ALLOW') return undefined;
      if (verdict === 'DENY') return { block: true, reason: 'The security system denied this tool call.' };
      throw new Error('The judge returned no valid decision.');
    } catch {
      if (signal?.aborted) return stopped();
      if (retry === 10) return { block: true, reason: 'The security system failed to evaluate this tool call. This is not indicative of a block. You may retry shortly.' };
      try { await timers.setTimeout(Math.min(250 * 2 ** retry, 2000), undefined, { signal }); } catch { return stopped(); }
    }
  }
}
