// Scoring for the racket sports. Pure, no DOM.
// tabletennis: first to 7, win by 2 (cap 11), serve swaps every 2 points.
// tennis: 0/15/30/40/deuce/advantage games, first to 2 games, serve swaps each game.

export type ScoreKind = 'tabletennis' | 'tennis'

export interface ScoreView {
  you: string
  cpu: string
  /** Games won (tennis only). */
  youSets: number | null
  cpuSets: number | null
  label: string
  /** Final score line for the end card. */
  final: string
}

export interface PointResult {
  matchOver: boolean
  /** Who serves next: 1 player, -1 CPU. */
  server: 1 | -1
  /** Callout that replaces the default one (DEUCE, GAME, ...). */
  call?: string
}

export interface Score {
  point(winner: 1 | -1): PointResult
  view(): ScoreView
  reset(): void
}

const TT_TO = 7
const TT_CAP = 11
const GAMES_TO = 2
const CALLS = ['0', '15', '30', '40']

export function createScore(kind: ScoreKind): Score {
  let you = 0
  let cpu = 0
  let gYou = 0
  let gCpu = 0
  let server: 1 | -1 = 1
  let served = 0
  let over = false

  function reset(): void {
    you = cpu = gYou = gCpu = served = 0
    server = 1
    over = false
  }

  function point(w: 1 | -1): PointResult {
    if (over) return { matchOver: true, server }
    if (w === 1) you++
    else cpu++
    if (kind === 'tabletennis') {
      const lead = you - cpu
      if ((you >= TT_TO || cpu >= TT_TO) && (Math.abs(lead) >= 2 || you >= TT_CAP || cpu >= TT_CAP)) {
        over = true
        return { matchOver: true, server }
      }
      served++
      if (served >= 2 || (you >= TT_TO - 1 && cpu >= TT_TO - 1)) {
        served = 0
        server = server === 1 ? -1 : 1
      }
      const mp = (you >= TT_TO - 1 && you > cpu) || (cpu >= TT_TO - 1 && cpu > you)
      return { matchOver: false, server, call: you === cpu && you >= TT_TO - 1 ? 'DEUCE!' : mp ? 'MATCH POINT' : undefined }
    }
    // tennis game
    if ((you >= 4 || cpu >= 4) && Math.abs(you - cpu) >= 2) {
      const won = you > cpu
      if (won) gYou++
      else gCpu++
      you = cpu = 0
      server = server === 1 ? -1 : 1
      if (gYou >= GAMES_TO || gCpu >= GAMES_TO) {
        over = true
        return { matchOver: true, server }
      }
      return { matchOver: false, server, call: won ? 'GAME YOU!' : 'GAME CPU' }
    }
    if (you >= 3 && you === cpu) return { matchOver: false, server, call: 'DEUCE!' }
    if (you >= 3 && cpu >= 3) return { matchOver: false, server, call: you > cpu ? 'ADVANTAGE YOU' : 'ADVANTAGE CPU' }
    return { matchOver: false, server }
  }

  function view(): ScoreView {
    if (kind === 'tabletennis')
      return { you: String(you), cpu: String(cpu), youSets: null, cpuSets: null, label: `TO ${TT_TO}`, final: `${you} – ${cpu}` }
    let a: string
    let b: string
    if (you >= 3 && cpu >= 3) {
      a = you === cpu ? '40' : you > cpu ? 'AD' : '40'
      b = you === cpu ? '40' : cpu > you ? 'AD' : '40'
    } else {
      a = CALLS[Math.min(you, 3)]
      b = CALLS[Math.min(cpu, 3)]
    }
    return { you: a, cpu: b, youSets: gYou, cpuSets: gCpu, label: 'GAMES', final: `${gYou} – ${gCpu}` }
  }

  return { point, view, reset }
}
