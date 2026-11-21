/*
 * isabelle_profile: where a theory spends its time, by lemma or by command.
 *
 * The server reports each command with its time and the lemma -- or other theory command --
 * it belongs to (PIDE/agent_profile); grouping, filtering and the text are here, without
 * `vscode`, so that the unit tests reach them.
 */

/** A command as the server reports it; `line` is 0-based. */
export interface ProfileCommand {
  line: number
  command: string
  source: string
  /** A command of a proof: what an agent can make faster. */
  proof: boolean
  seconds: number
  group: string
  group_line: number
}

export interface ProfileOptions {
  by: 'lemma' | 'command'
  kinds: 'proofs' | 'all'
  /** Lemma names, matched exactly, or text, matched in a command's first line. */
  match: string[]
  exclude: string[]
  /** 1-based, inclusive. */
  fromLine?: number
  toLine?: number
  limit: number
  minS: number
}

export interface ProfileStatus {
  name: string
  /** Still being checked: the times are those so far. */
  pending: boolean
  percentage: number
}

const s = (seconds: number) => `${seconds.toFixed(seconds < 10 ? 2 : 1)} s`

/** A name matches a group of that name; any other text a command whose first line has it. */
function matcher(patterns: string[], groups: Set<string>): (c: ProfileCommand) => boolean {
  const names = patterns.filter(p => groups.has(p))
  const texts = patterns.filter(p => !groups.has(p))
  return c => names.includes(c.group) || texts.some(t => c.source.includes(t))
}

export function formatProfile(all: ProfileCommand[], opts: ProfileOptions, status: ProfileStatus)
    : string {
  const groups = new Set(all.map(c => c.group))
  const total = all.reduce((t, c) => t + c.seconds, 0)
  const inRange = all.filter(c =>
    (opts.fromLine === undefined || c.line + 1 >= opts.fromLine) &&
    (opts.toLine === undefined || c.line + 1 <= opts.toLine))
  const kindHidden = opts.kinds === 'proofs' ? inRange.filter(c => !c.proof) : []
  const excluded = matcher(opts.exclude, groups)
  const counted = inRange.filter(c => opts.kinds === 'all' || c.proof)
  const userHidden = counted.filter(excluded)
  const matched = opts.match.length ? matcher(opts.match, groups) : () => true
  const shown = counted.filter(c => !excluded(c) && matched(c))

  const out: string[] = []
  const state = status.pending ? `still being checked (${status.percentage}%): the times so far` : 'checked'
  out.push(`${status.name}: ${s(total)} in all, over ${all.length} commands; ${state}. ` +
    'Times are per command and add up across proofs that run in parallel.')

  if (opts.by === 'lemma') {
    const byGroup = new Map<string, { name: string; line: number; seconds: number; slowest: ProfileCommand }>()
    for (const c of shown) {
      const key = `${c.group}\n${c.group_line}`
      const g = byGroup.get(key)
      if (!g) byGroup.set(key, { name: c.group, line: c.group_line, seconds: c.seconds, slowest: c })
      else {
        g.seconds += c.seconds
        if (c.seconds > g.slowest.seconds) g.slowest = c
      }
    }
    const rows = [...byGroup.values()].filter(g => g.seconds >= opts.minS)
      .sort((a, b) => b.seconds - a.seconds).slice(0, opts.limit)
    out.push('', rows.length ? `slowest ${opts.kinds === 'proofs' ? 'proofs' : 'parts'}, by lemma or command they belong to:`
      : `Nothing took ${s(opts.minS)} or more.`)
    for (const g of rows) {
      out.push(`  ${s(g.seconds).padStart(8)}  ${g.name} (line ${g.line + 1}); slowest: ` +
        `line ${g.slowest.line + 1}, ${g.slowest.source} (${s(g.slowest.seconds)})`)
    }
  } else {
    const rows = shown.filter(c => c.seconds >= opts.minS)
      .sort((a, b) => b.seconds - a.seconds).slice(0, opts.limit)
    out.push('', rows.length ? 'slowest commands:' : `Nothing took ${s(opts.minS)} or more.`)
    for (const c of rows) {
      out.push(`  ${s(c.seconds).padStart(8)}  line ${c.line + 1}: ${c.source}  (in ${c.group})`)
    }
  }

  const sum = (cs: ProfileCommand[]) => s(cs.reduce((t, c) => t + c.seconds, 0))
  if (userHidden.length) {
    out.push('', `excluded: ${userHidden.length} command${userHidden.length === 1 ? '' : 's'}, ` +
      `${sum(userHidden)} (exclude: ${opts.exclude.join(', ')})`)
  }
  if (kindHidden.length) {
    out.push(`not counted: ${kindHidden.length} command${kindHidden.length === 1 ? '' : 's'} ` +
      `outside proofs, ${sum(kindHidden)}: imports, definitions, packages and the like ` +
      '(kinds: "all" counts them)')
  }
  return out.join('\n')
}
