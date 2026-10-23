import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from "react";
import { EditorState } from "@codemirror/state";
import { resolveAnchor } from "../../packages/novel-domain/anchors.mjs";
import {
  EditorView,
  drawSelection,
  keymap,
  placeholder,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  isolateHistory,
  redo,
  undo,
} from "@codemirror/commands";

export type ManuscriptHandle = {
  focus(): void;
  select(start: number, end: number): void;
  undo(): void;
  redo(): void;
};
export type TextAnchor = {
  start: number;
  end: number;
  quote: string;
  prefix: string;
  suffix: string;
  hash: string;
};
export type RevealTarget = {
  documentKey: string;
  start: number;
  end: number;
  request: number;
  anchor?: TextAnchor;
};
type Props = {
  documentKey: string;
  value: string;
  typewriter?: boolean;
  reveal?: RevealTarget | null;
  onRevealIssue?: (message: string) => void;
  onChange: (value: string) => void;
  onSelection: (range: { start: number; end: number }) => void;
  onComposition: (active: boolean) => void;
};

export const ManuscriptEditor = forwardRef<ManuscriptHandle, Props>(
  function ManuscriptEditor(props, ref) {
    const host = useRef<HTMLDivElement>(null),
      editor = useRef<EditorView | null>(null),
      revealed = useRef<Props["reveal"]>(null),
      centeringFrame = useRef(0),
      latest = useRef(props);
    latest.current = props;
    useImperativeHandle(
      ref,
      () => ({
        focus() {
          editor.current?.focus();
        },
        select(start, end) {
          const view = editor.current;
          if (!view) return;
          view.dispatch({
            selection: {
              anchor: Math.min(start, view.state.doc.length),
              head: Math.min(end, view.state.doc.length),
            },
            scrollIntoView: true,
          });
          view.focus();
        },
        undo() {
          if (editor.current) undo(editor.current);
        },
        redo() {
          if (editor.current) redo(editor.current);
        },
      }),
      [],
    );
    useLayoutEffect(() => {
      if (!host.current) return;
      const value = latest.current.value;
      let saved = { anchor: 0, head: 0 };
      try {
        const cached = JSON.parse(
          localStorage.getItem(`zinovel.cursor.${props.documentKey}`) || "null",
        );
        if (
          cached &&
          Number.isInteger(cached.anchor) &&
          Number.isInteger(cached.head)
        )
          saved = {
            anchor: Math.max(0, Math.min(cached.anchor, value.length)),
            head: Math.max(0, Math.min(cached.head, value.length)),
          };
      } catch {}
      const view = new EditorView({
        parent: host.current,
        state: EditorState.create({
          doc: value,
          selection: saved,
          extensions: [
            history(),
            keymap.of([...historyKeymap, ...defaultKeymap]),
            drawSelection(),
            EditorView.lineWrapping,
            EditorView.contentAttributes.of({
              "aria-label": "正文编辑器",
              "aria-multiline": "true",
              spellcheck: "false",
            }),
            placeholder("在这里写下故事的第一句话……"),
            EditorView.theme({
              "&": {
                height: "100%",
                backgroundColor: "transparent",
                color: "var(--text)",
              },
              ".cm-scroller": {
                fontFamily: '"Noto Serif SC", "SimSun", serif',
                fontSize: "20px",
                lineHeight: "2.1",
                overflow: "auto",
              },
              ".cm-content": {
                padding: "0 8px 80px",
                caretColor: "var(--text)",
                minHeight: "240px",
              },
              ".cm-line": { padding: "0" },
              "&.cm-focused": { outline: "none" },
              ".cm-cursor": { borderLeftColor: "var(--text)" },
              "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
                backgroundColor: "var(--selected)",
              },
            }),
            EditorView.domEventHandlers({
              compositionstart() {
                latest.current.onComposition(true);
                return false;
              },
              compositionend() {
                latest.current.onComposition(false);
                return false;
              },
            }),
            EditorView.updateListener.of((update) => {
              if (update.docChanged)
                latest.current.onChange(update.state.doc.toString());
              if (update.selectionSet || update.docChanged) {
                const range = update.state.selection.main;
                latest.current.onSelection({
                  start: range.from,
                  end: range.to,
                });
                try {
                  localStorage.setItem(
                    `zinovel.cursor.${latest.current.documentKey}`,
                    JSON.stringify({ anchor: range.anchor, head: range.head }),
                  );
                } catch {}
                if (latest.current.typewriter) {
                  cancelAnimationFrame(centeringFrame.current);
                  centeringFrame.current = requestAnimationFrame(() => {
                    if (editor.current === update.view)
                      update.view.dispatch({
                        effects: EditorView.scrollIntoView(
                          update.view.state.selection.main.head,
                          { y: "center" },
                        ),
                      });
                  });
                }
              }
            }),
          ],
        }),
      });
      editor.current = view;
      latest.current.onSelection({
        start: Math.min(saved.anchor, saved.head),
        end: Math.max(saved.anchor, saved.head),
      });
      return () => {
        cancelAnimationFrame(centeringFrame.current);
        view.destroy();
        editor.current = null;
      };
    }, [props.documentKey]);
    useEffect(() => {
      const view = editor.current;
      if (!view) return;
      const before = view.state.doc.toString(),
        after = props.value;
      if (before === after) return;
      // Preserve unaffected text and make each AI/history replacement one undo step.
      let from = 0;
      while (
        from < before.length &&
        from < after.length &&
        before[from] === after[from]
      )
        from++;
      let oldEnd = before.length,
        newEnd = after.length;
      while (
        oldEnd > from &&
        newEnd > from &&
        before[oldEnd - 1] === after[newEnd - 1]
      ) {
        oldEnd--;
        newEnd--;
      }
      view.dispatch({
        changes: { from, to: oldEnd, insert: after.slice(from, newEnd) },
        annotations: isolateHistory.of("full"),
        userEvent: "input.replace",
      });
    }, [props.value]);
    // Run after the target document and its content have committed. A requestAnimationFrame
    // in the caller can run before React commits the asynchronous chapter switch.
    useEffect(() => {
      const view = editor.current,
        target = props.reveal;
      if (!view || !target || target.documentKey !== props.documentKey) return;
      if (revealed.current === target) return;
      revealed.current = target;
      const range = target.anchor
        ? resolveAnchor(view.state.doc.toString(), target.anchor, undefined)
        : { ...target, status: "exact" };
      if (range.start === null || range.end === null) {
        latest.current.onRevealIssue?.(
          range.status === "ambiguous"
            ? "证据引文在当前稿件中有多个匹配，未自动选择位置。请对照原始引文查找。"
            : "证据引文在当前稿件中已找不到，未自动选择位置。原始引文仍保留在资料中。",
        );
        return;
      }
      view.dispatch({
        selection: {
          anchor: Math.max(0, Math.min(range.start, view.state.doc.length)),
          head: Math.max(0, Math.min(range.end, view.state.doc.length)),
        },
        scrollIntoView: true,
      });
      // The modal boundary removes background inertness in a MutationObserver.
      // Focus on the frame after this already-committed document, not before that cleanup.
      const frame = requestAnimationFrame(() => {
        if (editor.current === view) view.focus();
      });
      return () => cancelAnimationFrame(frame);
    }, [props.reveal, props.documentKey]);
    useEffect(() => {
      const view = editor.current;
      if (props.typewriter && view)
        view.dispatch({
          effects: EditorView.scrollIntoView(view.state.selection.main.head, {
            y: "center",
          }),
        });
    }, [props.typewriter]);
    return (
      <div
        className={`manuscript-editor ${props.typewriter ? "typewriter" : ""}`}
        ref={host}
      />
    );
  },
);
