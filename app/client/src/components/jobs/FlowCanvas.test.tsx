import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { THIRTY_NODE_FLOW } from '../../../../shared/flow/__tests__/thirty-nodes'

/**
 * Card B7 (obj 900643) — "Canvas is non-editable (no drag/connect handlers
 * registered)". Two angles:
 *   1. the props handed to <ReactFlow> (captured through a pass-through mock):
 *      every editing switch is off and NO change/connect/drag/delete/reconnect
 *      handler is registered — only click-to-inspect and pane click;
 *   2. the real React Flow render in jsdom: no node gets React Flow's
 *      `draggable` class and no handle is `connectable`.
 */

const captured: { props: Record<string, unknown> | null } = { props: null }
let useMock = true

vi.mock('@xyflow/react', async importOriginal => {
  const actual = await importOriginal<typeof import('@xyflow/react')>()
  const ReactFlow = (props: Record<string, unknown>) => {
    captured.props = props
    if (!useMock) {
      const Real = actual.ReactFlow as unknown as React.ComponentType<Record<string, unknown>>
      return <Real {...props} />
    }
    const nodes = props.nodes as { id: string; data: { status?: string } }[]
    return (
      <div data-testid="rf-mock">
        {nodes.map(n => (
          <button key={n.id} data-testid={`rf-node-${n.id}`} data-status={n.data.status ?? ''}
            onClick={() => (props.onNodeClick as (e: unknown, n: unknown) => void)?.({}, n)} />
        ))}
      </div>
    )
  }
  return { ...actual, ReactFlow }
})

const { FlowCanvas } = await import('./FlowCanvas')

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = false

// Every React Flow prop that could change the graph (v12 API). None may be registered.
const EDIT_HANDLERS = [
  'onNodesChange', 'onEdgesChange', 'onConnect', 'onConnectStart', 'onConnectEnd', 'onClickConnectStart', 'onClickConnectEnd',
  'onReconnect', 'onReconnectStart', 'onReconnectEnd', 'onNodeDragStart', 'onNodeDrag', 'onNodeDragStop',
  'onSelectionDragStart', 'onSelectionDrag', 'onSelectionDragStop', 'onNodesDelete', 'onEdgesDelete', 'onDelete',
  'onBeforeDelete', 'onDrop', 'onDragOver', 'isValidConnection',
]

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  container.style.width = '1000px'
  container.style.height = '800px'
  document.body.appendChild(container)
  root = createRoot(container)
  captured.props = null
})
afterEach(() => {
  flushSync(() => root.unmount())
  container.remove()
  useMock = true
})

describe('FlowCanvas — read-only', () => {
  it('registers no drag / connect / change / delete handlers and turns every editing switch off', () => {
    const onSelect = vi.fn()
    flushSync(() => root.render(<FlowCanvas definition={THIRTY_NODE_FLOW} onSelectNode={onSelect} />))
    const p = captured.props!
    expect(p).toBeTruthy()
    for (const h of EDIT_HANDLERS) expect(p[h], `${h} must not be registered`).toBeUndefined()
    expect(p).toMatchObject({
      nodesDraggable: false,
      nodesConnectable: false,
      edgesReconnectable: false,
      edgesFocusable: false,
      connectOnClick: false,
      selectNodesOnDrag: false,
      deleteKeyCode: null,
      selectionKeyCode: null,
      multiSelectionKeyCode: null,
    })
    // the only registered handlers are click-to-inspect and "click empty canvas to close"
    const handlers = Object.keys(p).filter(k => /^on[A-Z]/.test(k) && typeof p[k] === 'function').sort()
    expect(handlers).toEqual(['onNodeClick', 'onPaneClick'])
    for (const n of p.nodes as { draggable: boolean; connectable: boolean; deletable: boolean }[]) {
      expect([n.draggable, n.connectable, n.deletable]).toEqual([false, false, false])
    }
    // click-to-inspect still works
    ;(container.querySelector('[data-testid="rf-node-score"]') as HTMLButtonElement).click()
    expect(onSelect).toHaveBeenCalledWith('score')
  })

  it('in a real React Flow render, no node is draggable and no handle is connectable', async () => {
    useMock = false
    // jsdom lacks the layout observers React Flow uses.
    const g = globalThis as unknown as Record<string, unknown>
    g.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} }
    g.DOMMatrixReadOnly ??= class { m22 = 1; constructor() {} }
    flushSync(() => root.render(<FlowCanvas definition={THIRTY_NODE_FLOW} />))
    for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0))
    const nodes = container.querySelectorAll('.react-flow__node')
    expect(nodes.length).toBe(30)
    expect(container.querySelectorAll('.react-flow__node.draggable').length).toBe(0)
    expect(container.querySelectorAll('.react-flow__handle.connectable').length).toBe(0)
    // isConnectableStart/End default to TRUE in React Flow even when isConnectable is false —
    // a pointer-down on such a handle would still start a connection line. Both must be off.
    expect(container.querySelectorAll('.react-flow__handle').length).toBe(60)
    expect(container.querySelectorAll('.react-flow__handle.connectablestart').length).toBe(0)
    expect(container.querySelectorAll('.react-flow__handle.connectableend').length).toBe(0)
    // kind/effect styling reached the DOM
    expect(container.querySelector('[data-testid="flow-node-score"]')?.getAttribute('data-kind')).toBe('llm')
    expect(container.querySelector('[data-testid="flow-node-post_summary"]')?.getAttribute('data-effect')).toBe('send')
    expect(container.querySelector('[data-testid="flow-node-score_each"]')?.getAttribute('data-kind')).toBe('loop')
    // no edit toolbar / interactivity toggle
    expect(container.querySelector('.react-flow__controls-interactive')).toBeNull()
  })
})
