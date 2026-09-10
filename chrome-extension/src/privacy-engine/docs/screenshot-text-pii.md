# Screenshot text PII: current state and design for closing the gap

## Current state (accurate, as of this phase)

`VisionDetector` runs `Xenova/yolos-tiny`, an **object detector** trained on
COCO. It can tell you "there is a person-shaped region at (x,y)". It **cannot
read text**. Nothing in this codebase currently performs OCR or text
recognition on a screenshot. Concretely, today:

| Sensitive text scenario | Currently caught? | How |
|---|---|---|
| Password typed into `<input type=password>` | ✅ | `DOMDetector` (field semantics), redacted in the DOM text listing |
| Password's on-screen pixels in the screenshot | ✅ (new this phase, see below) | DOM→screenshot coordinate correlation, IF the host's DOM extraction populates `viewportCoordinates` |
| Email address as a visible `<div>` text node | ✅ | `RegexDetector` on DOM text nodes |
| That email's on-screen pixels in the screenshot | ✅ (same mechanism, if coordinates are populated) | as above |
| A person's face in a webcam preview `<video>`/`<img>` | Partial | `VisionDetector`'s `person` class (a face-specific model would be more precise — see below) |
| Text baked into a **photo/scan** with no DOM node (e.g. a photographed ID card, a screenshot pasted as an `<img>`) | ❌ | Nothing today. This is the real remaining gap. |
| Handwriting, watermarked/stylized text | ❌ | Same gap, harder still |

**We do not claim `VisionDetector` finds textual PII in screenshots. It doesn't.**

## What shipped this phase (zero new dependencies)

DOM detection already knows *which* elements are sensitive (password fields,
labelled Aadhaar/PAN/passport inputs, regex-matched emails/phones in text
nodes) with much higher precision than any local vision model could get from
pixels alone. The missing piece was purely plumbing: NanoBrowser's
`DOMElementNode.viewportCoordinates` field already exists for exactly this
purpose, but nothing currently populates it (the injected content script,
`public/buildDomTree.js`, computes `getBoundingClientRect()` for every element
already, for visibility checks — it just doesn't serialize the rect back).

This phase wires up the **consuming** side end-to-end and unit-tests it:

- `GenericDomNode.bbox` — carries a node's on-screen rectangle, in the same
  pixel space as the screenshot.
- `domTranslate.ts` reads `DOMElementNode.viewportCoordinates` into `bbox` if
  present.
- `DOMDetector`/`RegexDetector` copy `node.bbox` onto any `SensitiveRegion`
  they raise for that node.
- `PrivacyEngine`'s redaction step now blacks out **every** region with a
  `bbox` on the screenshot — vision detections AND DOM-anchored ones — using
  the same `ImageRedactor` either way.

Today, `viewportCoordinates` is unpopulated in a real browser run, so `bbox`
is `undefined` for DOM regions and this path is a no-op — but it is real,
tested code (`PrivacyEngine.test.ts` exercises it with a synthetic bbox), not
a placeholder, and it activates automatically the moment coordinates are
supplied — no further engine changes needed.

## Remaining work to fully close the gap (next steps, in priority order)

### 1. Populate `viewportCoordinates` (small, no new dependencies, needs real-browser testing)

Concretely: in `public/buildDomTree.js`, the per-element `rect` (from
`getBoundingClientRect()`, already computed at the site emitting
`nodeData.attributes['computedHeight'/'computedWidth']` and in the visibility
checks) needs to be serialized onto `nodeData` as e.g. `nodeData.rect = {
top, left, width, height }`. Then:

- `raw_types.ts`'s `RawDomTreeNode` needs a matching optional field.
- `service.ts::_parse_node` needs to map that into
  `viewportCoordinates: CoordinateSet` when constructing `DOMElementNode`.

This closes the DOM-anchored part of the gap (form fields, visible text
nodes) completely, using code that's already written and tested on this side.
It was **not done in this pass** because it requires modifying and verifying
behavior in `public/buildDomTree.js` inside a real Chrome tab — something
this environment cannot execute or screenshot-verify, and shipping an
unverified change to the content script that's injected into every page the
extension touches is exactly the kind of "claim it's done without proving it"
this project explicitly wants avoided. It needs a contributor with a real
Chrome extension dev environment to implement and verify against a live page.

### 2. Local OCR for text with no DOM node (bigger, needs a dependency decision)

This is the only way to catch PII in a **photographed/scanned image** with no
backing DOM element — e.g. a passport photo pasted into an `<img>`, or a
screenshot-of-a-screenshot. Options, roughly in order of footprint:

- **Do nothing extra, rely on (1) + `VisionDetector`'s `person`/object
  detection**, and accept this residual risk for the hackathon's timeline.
  Reasonable default given "keep dependencies minimal."
- **A lightweight local text-detection model** (e.g. a CRAFT/DBNet-style text
  *region* detector) via `@huggingface/transformers` (already a dependency —
  no new package) to find text bounding boxes and simply blur/black them out
  wholesale, without reading their content. Cheaper than full OCR, and doesn't
  need to know *what* the text says to redact it — only *where* it is. This is
  the best next increment if evaluation shows the "text baked into an image"
  scenario matters for the demo.
- **Full OCR + regex** (e.g. `Xenova/trocr-small-printed` via
  `@huggingface/transformers`, or `tesseract.js` as a new dependency) to
  actually read the text and run it through the same `patterns.ts` regexes
  before deciding what to redact. Most capable, most expensive (model size +
  inference latency), and the most likely to need a real dependency add
  (`tesseract.js`) if `@huggingface/transformers`'s OCR models prove too slow
  in a browser extension's service worker.

Per instructions, we do **not** add a new OCR dependency preemptively. The
next step is to run the SIH evaluation harness (Part 17) against a page with
image-only PII and see whether (1) + `VisionDetector` already leaves an
unacceptable recall gap; only then pick the cheapest option above that closes
it.
