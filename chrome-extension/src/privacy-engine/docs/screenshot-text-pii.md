# Screenshot text PII: current state and design for closing the remaining gap

## Current state (accurate, real-browser verified)

`VisionDetector` runs `Xenova/yolos-tiny`, an **object detector** trained on
COCO. It can tell you "there is a person-shaped region at (x,y)". It **cannot
read text**. Nothing in this codebase performs OCR or text recognition on a
screenshot. Concretely:

| Sensitive text scenario | Currently caught? | How |
|---|---|---|
| Password typed into `<input type=password>` | ✅ verified | `DOMDetector` (field semantics), redacted in the DOM text listing |
| Password's on-screen pixels in the screenshot | ✅ verified | DOM→screenshot coordinate correlation (see below) |
| Email/phone/PAN/Aadhaar/passport/credit-card as a DOM attribute or visible text node | ✅ verified | `RegexDetector` on DOM text/attributes |
| Those values' on-screen pixels in the screenshot | ✅ verified | same coordinate correlation |
| A person's face in a webcam preview `<video>`/`<img>` | Partial, unverified | `VisionDetector`'s `person` class (a face-specific model would be more precise — see below); also currently fails closed inside the MV3 service worker (see PRIVACY.md) |
| Text baked into a **photo/scan** with no DOM node (e.g. a photographed ID card, a screenshot pasted as an `<img>`) | ❌ | Nothing today. This is the real remaining gap. |
| Handwriting, watermarked/stylized text | ❌ | Same gap, harder still |

**We do not claim `VisionDetector` finds textual PII in screenshots. It doesn't.**

## What shipped and has been REAL-BROWSER VERIFIED

DOM detection already knows *which* elements are sensitive (password fields,
labelled Aadhaar/PAN/passport inputs, regex-matched emails/phones in text
nodes) with much higher precision than any local vision model could get from
pixels alone. `DOMElementNode.viewportCoordinates` existed as a field but was
never populated by the content script — this was wired up and verified
end-to-end against a real rendered page (not just unit tests):

- `public/buildDomTree.js` serializes each element's cached bounding rect
  (via the existing `getCachedBoundingRect()`/iframe-offset mechanism, not a
  fresh `getBoundingClientRect()` call) into `nodeData.viewportCoordinates`.
- `background/browser/dom/service.ts::_parse_node` maps that into
  `DOMElementNode.viewportCoordinates`.
- `domTranslate.ts` reads it into `GenericDomNode.bbox`.
- `DOMDetector`/`RegexDetector` copy `node.bbox` onto any `SensitiveRegion`
  they raise for that node.
- `PrivacyEngine`'s redaction step blacks out every region with a `bbox` on
  the screenshot — vision detections AND DOM-anchored ones — via the same
  `ImageRedactor`.

**Verification method**: a real Chrome page (via Puppeteer driving a real
Chromium binary, not headless-DOM emulation) containing password/email/phone/
passport/Aadhaar/credit-card fields was loaded; the actual built
`buildDomTree.js` was injected and run exactly as
`chrome.scripting.executeScript` does; a real screenshot was taken; the
actual `PrivacyEngine`/`domTranslate` code (unmodified, bundled with esbuild)
ran inside that same real page. Result: all six fields were detected with
correct `viewportCoordinates`, the DOM listing that would be sent to the LLM
showed only semantic placeholders, and — checked by sampling pixel colors
before vs. after — each field's exact on-screen rectangle was blacked out in
the screenshot while an unrelated, non-sensitive field and the page heading
were pixel-identical before/after. No raw value (email, password, passport
number, Aadhaar number, card number, phone number) appeared anywhere in the
sanitized output.

This closes the DOM-anchored part of the screenshot-text gap completely for
real elements with real on-screen positions. It does not, and cannot, help
with PII that has no backing DOM element (see below).

## Known limitation found this phase: vision fails closed inside the service worker

Separately from the OCR gap, if vision analysis is actually invoked (screenshot
present, vision enabled), it currently runs inside the MV3 background service
worker and depends on `@huggingface/transformers`/onnxruntime-web, which
references `document` at module-load time — unavailable in a service worker.
This is handled safely: the dynamic import throws, `VisionDetector.detect()`
propagates that, and `PrivacyEngine` fails closed (blocks the request) rather
than sending an unanalyzed screenshot. But it means vision-based object
detection does not currently *complete* inside the service worker — every
vision-requiring request is blocked, not actually analyzed. See PRIVACY.md's
"MV3 service worker safety" section. The architecturally correct fix (not
implemented) is running vision inference in a `chrome.offscreen` document.

## Remaining work: local OCR / text-region detection for image-only PII

This is the only way to catch PII in a **photographed/scanned image** with no
backing DOM element — e.g. a passport photo pasted into an `<img>`, or a
screenshot-of-a-screenshot. Options, roughly in order of footprint:

- **Do nothing extra**, rely on DOM/regex coverage (which is now solid and
  verified) + `VisionDetector`'s `person` detection, and accept this residual
  risk for the hackathon's timeline. Reasonable default given "keep
  dependencies minimal."
- **A lightweight local text-detection model** (e.g. a CRAFT/DBNet-style text
  *region* detector) via `@huggingface/transformers` (already a dependency —
  no new package) to find text bounding boxes and simply blur/black them out
  wholesale, without reading their content. Cheaper than full OCR, and doesn't
  need to know *what* the text says to redact it — only *where* it is. This is
  the best next increment if evaluation shows the "text baked into an image"
  scenario matters for the demo. Note: this would need the offscreen-document
  fix above to actually run, for the same reason `VisionDetector` does.
- **Full OCR + regex** (e.g. `Xenova/trocr-small-printed` via
  `@huggingface/transformers`, or `tesseract.js` as a new dependency) to
  actually read the text and run it through the same `patterns.ts` regexes
  before deciding what to redact. Most capable, most expensive (model size +
  inference latency).

Per instructions, we do **not** add a new OCR dependency preemptively. The
next step is to run the SIH evaluation harness (Part 17) against a page with
image-only PII and see whether DOM/regex coverage + `VisionDetector` already
leaves an unacceptable recall gap; only then pick the cheapest option above
that closes it — after first fixing the offscreen-document issue so vision
can actually run at all.
