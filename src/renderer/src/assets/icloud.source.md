# iCloud rail icon provenance

## Source (verified 2026-11-24, Asia/Shanghai)

- Publisher / artwork owner: Apple Inc.
- Public page: https://www.icloud.com/
- Source image: https://www.icloud.com/system/icloud.com/2642Build23/favicons/default-favicon-light-180x180.png
- Discovery: the page declares `<base href="/system/icloud.com/2642Build23/en-us/">` and an `apple-touch-icon` link to `../favicons/default-favicon-light-180x180.png`.
- Original: 180 x 180 PNG; SHA-256 `75587923b33c96fd83dce9970412d620d69efb46ff77460c64bcc8a07b0349a2`.

This is derived from an actual Apple-hosted iCloud brand image, NOT from a generic cloud icon library, NOT a hand-drawn substitute, and NOT an Apple-supplied SVG. The repository SVG is a raster-traced monochrome adaptation of that PNG.

## Adaptation

1. Extract the blue cloud silhouette, omitting the white rounded-square background and drop shadow: RGB pixels satisfying `B-R > 32`, `B-G > 4`, `B > 120` are foreground.
2. Trace that binary silhouette with VTracer 0.6.15, binary / spline mode, filter_speckle=4, corner_threshold=60, length_threshold=4, max_iterations=10, splice_threshold=45, path_precision=4.
3. Preserve the generated path. Apply only translation and uniform scale into a 24 x 24 viewBox, approximately 22 units wide, centered. Source silhouette bounds: (18, 40)-(161, 133).
4. Use the SVG alpha silhouette as a CSS mask, matching the existing rekordbox entry's rendering method: currentColor, theme text / opacity tokens, 25 px icon box. Gradients and internal overlapping color regions are deliberately flattened.

Source-resolution rasterized trace vs thresholded PNG silhouette IoU: 0.9862 (CairoSVG alpha threshold 128). This quantifies a close raster trace, not exact vector equivalence to Apple's original artwork.

## Rights / limitations

- iCloud and its brand artwork are Apple trademarks / artwork. No open-source or unrestricted redistribution license was found for the Apple-hosted PNG. Public availability is not a license grant.
- Apple usage guidelines: https://www.apple.com/legal/intellectual-property/guidelinesfor3rdparties.html
- This local preview adaptation does not imply Apple's affiliation, sponsorship or approval. Trademark / artwork permission must be reviewed before distributing a release; do not label this asset CC0, MIT, or Apple-approved.
- Wikimedia's separately reconstructed logo was researched but is NOT the source of this icon.
