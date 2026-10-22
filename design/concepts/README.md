# Workbench concept and implementation review

`workbench-v1.png` is an AI-generated visual concept produced for this project on
2026-10-22. It is a design reference, not a screenshot of working functionality.
Brief: Chinese novel-writing desktop, slate rail, pale chapter tree, white serif
manuscript, teal accents, reference/assistant inspector, clear saved state.

The actual Electron light/dark/narrow screenshots are in
[Stage-001 screenshots](../../screenshots/stage-001). They were opened and visually
compared against the concept at 1426×923 CSS pixels, Windows scale 125%.

| Anchor | Implementation finding |
| --- | --- |
| Four-column hierarchy | Preserved 72 px rail, 246 px chapter tree, flexible manuscript, 288 px inspector |
| Typography and contrast | Serif chapter/body with sans-serif controls; light and dark text readable |
| Teal selection and actions | Preserved selected chapter, saved indicator and primary assistant action |
| Manuscript emphasis | Wide white writing area; current textarea uses native paragraph spacing; rich formatting deferred |
| Reference area | Real assistant, versions and export shown; character/place cards await domain implementation |

Intentional differences: only working navigation is exposed; no pretend world,
map or publish buttons. Native Windows title bar is retained. Narrow windows use
an inspector drawer. A real smoke failure found a persistent toast blocking the
drawer toggle; toasts moved below the editing controls and no longer capture
pointer events except their close button. Full accessibility and final editor
typography remain Stage-002/008 acceptance work.
