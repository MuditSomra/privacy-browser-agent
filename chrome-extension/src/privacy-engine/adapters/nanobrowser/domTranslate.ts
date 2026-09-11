/**
 * privacy-engine/adapters/nanobrowser/domTranslate.ts
 *
 * NanoBrowser-specific glue: converts NanoBrowser's DOMElementNode/DOMTextNode
 * tree into the engine's generic DOMSnapshot, and ensures redactions made by
 * the engine are reflected back onto the ORIGINAL NanoBrowser tree, so that
 * `elementTree.clickableElementsToString()` — NanoBrowser's own, unmodified
 * serialization method — naturally produces sanitized output afterwards.
 *
 * Only files under `privacy-engine/adapters/*` are allowed to import
 * NanoBrowser modules. Nothing here is imported by `privacy-engine/core`,
 * `detection`, `redaction`, or `fusion`.
 */
import { DOMElementNode, DOMTextNode } from '@src/background/browser/dom/views';
import type { DOMState } from '@src/background/browser/dom/views';
import type { DOMSnapshot, GenericDomNode } from '@src/privacy-engine/core/types';

/**
 * Builds a GenericDomNode tree that mirrors `root`.
 *  - `attributes` is the SAME object reference as the NanoBrowser node's
 *    attributes record, so any attribute the redactor overwrites is
 *    immediately reflected on the original tree (no write-back step needed).
 *  - `text` is defined via an accessor proxying to the underlying
 *    DOMTextNode's `text` field, for the same reason (plain string copies
 *    would not propagate back).
 */
export function toGenericDomSnapshot(root: DOMElementNode): DOMSnapshot {
  const nodesById = new Map<string, GenericDomNode>();
  let counter = 0;

  const convert = (node: DOMElementNode | DOMTextNode): GenericDomNode => {
    const id = `n${counter++}`;

    if (node instanceof DOMTextNode) {
      const generic: GenericDomNode = {
        id,
        tagName: null,
        attributes: {},
        isTextNode: true,
        children: [],
      };
      Object.defineProperty(generic, 'text', {
        enumerable: true,
        get: () => node.text,
        set: (v: string) => {
          node.text = v;
        },
      });
      nodesById.set(id, generic);
      return generic;
    }

    const generic: GenericDomNode = {
      id,
      tagName: node.tagName,
      attributes: node.attributes, // shared reference: writes propagate to the original tree
      // Populated by public/buildDomTree.js (via getCachedBoundingRect) and
      // mapped through in background/browser/dom/service.ts::_parse_node —
      // see PRIVACY.md's "screenshot region redaction" section. Falls back to
      // undefined for nodes buildDomTree.js didn't capture a rect for (e.g.
      // zero-size or not visible), in which case this node's SensitiveRegion
      // still gets redacted in the DOM/text listing, just not on the
      // screenshot.
      bbox: node.viewportCoordinates
        ? {
            xmin: node.viewportCoordinates.topLeft.x,
            ymin: node.viewportCoordinates.topLeft.y,
            xmax: node.viewportCoordinates.bottomRight.x,
            ymax: node.viewportCoordinates.bottomRight.y,
          }
        : undefined,
      children: [],
    };
    nodesById.set(id, generic);
    const childNodes = node.children.filter(
      (child): child is DOMElementNode | DOMTextNode => child instanceof DOMElementNode || child instanceof DOMTextNode,
    );
    generic.children = childNodes.map(convert);
    return generic;
  };

  return { root: convert(root), nodesById };
}

/** Convenience for building a snapshot straight from NanoBrowser's DOMState. */
export function domStateToSnapshot(domState: DOMState | null | undefined): DOMSnapshot | undefined {
  if (!domState?.elementTree) return undefined;
  return toGenericDomSnapshot(domState.elementTree);
}
