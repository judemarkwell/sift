/**
 * A tiny remark plugin that wraps values Sift restored from placeholders
 * (e.g. the real email where the model wrote [EMAIL_1]) in a <span>, so the
 * reply can show which parts the model never actually saw.
 */

interface Node {
  type: string
  value?: string
  children?: Node[]
  data?: Record<string, unknown>
}

export interface Restored {
  value: string
  placeholder: string
}

export function remarkRestored(items: Restored[]) {
  const usable = items.filter((i) => i.value.length > 1)
  return () => (tree: Node) => {
    if (!usable.length) return
    const walk = (node: Node) => {
      if (!node.children || node.type === 'code' || node.type === 'inlineCode') return
      const next: Node[] = []
      for (const child of node.children) {
        if (child.type !== 'text' || !child.value) {
          walk(child)
          next.push(child)
          continue
        }
        let parts: Node[] = [child]
        for (const item of usable) {
          parts = parts.flatMap((p) => {
            if (p.type !== 'text' || !p.value?.includes(item.value)) return [p]
            return p.value.split(item.value).flatMap((chunk, i, arr) => {
              const nodes: Node[] = chunk ? [{ type: 'text', value: chunk }] : []
              if (i < arr.length - 1) {
                nodes.push({
                  type: 'emphasis',
                  data: {
                    hName: 'span',
                    hProperties: {
                      className: 'pii-restored',
                      title: `The model saw ${item.placeholder}. Sift put the real value back for you.`,
                    },
                  },
                  children: [{ type: 'text', value: item.value }],
                })
              }
              return nodes
            })
          })
        }
        next.push(...parts)
      }
      node.children = next
    }
    walk(tree)
  }
}
