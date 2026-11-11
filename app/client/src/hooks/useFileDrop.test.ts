import { describe, it, expect } from 'vitest'
import { dragHasFiles } from './useFileDrop'

function fakeDrag(types: string[]) {
  return { dataTransfer: { types } }
}

describe('dragHasFiles', () => {
  it('is true for a Files drag', () => {
    expect(dragHasFiles(fakeDrag(['Files']))).toBe(true)
    expect(dragHasFiles(fakeDrag(['text/plain', 'Files']))).toBe(true)
  })

  it('is false for text or empty drags', () => {
    expect(dragHasFiles(fakeDrag(['text/plain']))).toBe(false)
    expect(dragHasFiles(fakeDrag([]))).toBe(false)
    expect(dragHasFiles({ dataTransfer: null } as unknown as React.DragEvent)).toBe(false)
  })
})
