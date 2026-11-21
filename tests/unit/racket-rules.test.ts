import { describe, expect, it } from 'vitest'
import { createScore } from '../../src/sports/racket/rules.ts'

describe('racket scoring', () => {
  it('table tennis: first to 7, win by 2, serve swaps every 2', () => {
    const s = createScore('tabletennis')
    expect(s.point(1).server).toBe(1)
    expect(s.point(1).server).toBe(-1)
    for (let i = 0; i < 4; i++) expect(s.point(1).matchOver).toBe(false)
    expect(s.point(1).matchOver).toBe(true)
    expect(s.view().final).toBe('7 – 0')
  })
  it('table tennis: 6-6 needs a 2 point lead', () => {
    const s = createScore('tabletennis')
    for (let i = 0; i < 6; i++) {
      s.point(1)
      s.point(-1)
    }
    expect(s.point(1).matchOver).toBe(false)
    expect(s.point(1).matchOver).toBe(true)
  })
  it('tennis: deuce, advantage, game, match at 2 games', () => {
    const s = createScore('tennis')
    for (let i = 0; i < 3; i++) {
      s.point(1)
      s.point(-1)
    }
    expect(s.view().you).toBe('40')
    expect(s.point(1).call).toBe('ADVANTAGE YOU')
    expect(s.view().you).toBe('AD')
    expect(s.point(1).call).toBe('GAME YOU!')
    for (let i = 0; i < 3; i++) s.point(1)
    expect(s.point(1).matchOver).toBe(true)
    expect(s.view().final).toBe('2 – 0')
  })
})
