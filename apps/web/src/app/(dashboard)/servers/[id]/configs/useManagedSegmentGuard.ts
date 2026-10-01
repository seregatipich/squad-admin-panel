'use client';
import type { OnMount } from '@monaco-editor/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { managedSegmentLineRange } from './managed-segment';

type EditorInstance = Parameters<OnMount>[0];
type MonacoInstance = Parameters<OnMount>[1];

/**
 * Admins.cfg managed-segment read-only enforcement (CFG-1, #63). monaco
 * 0.56.0 has no read-only-range API, so the segment is guarded by a
 * decorations overlay plus an undo of any edit that touches it — the rest
 * of the file stays editable.
 *
 * @param content Text currently shown in the editor.
 * @param isManagedAdmins The open file is Admins.cfg and carries a managed segment.
 * @returns `handleEditorMount` for the editor's `onMount`, and `segmentNotice`,
 *   which is `true` for a moment after an edit of the segment was undone.
 */
export function useManagedSegmentGuard(content: string, isManagedAdmins: boolean) {
  const editorRef = useRef<EditorInstance | null>(null);
  const monacoRef = useRef<MonacoInstance | null>(null);
  const decorationsRef = useRef<ReturnType<EditorInstance['createDecorationsCollection']> | null>(
    null,
  );
  const protectedRangeRef = useRef<{ startLine: number; endLine: number } | null>(null);
  const undoingRef = useRef(false);
  const [editorReady, setEditorReady] = useState(false);
  const [segmentNotice, setSegmentNotice] = useState(false);
  const segmentNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flashSegmentNotice = useCallback(() => {
    setSegmentNotice(true);
    if (segmentNoticeTimer.current) clearTimeout(segmentNoticeTimer.current);
    segmentNoticeTimer.current = setTimeout(() => setSegmentNotice(false), 2500);
  }, []);

  const handleEditorMount = useCallback<OnMount>(
    (editor, monaco) => {
      editorRef.current = editor;
      monacoRef.current = monaco;
      editor.onDidChangeModelContent((ev) => {
        // Ignore the model change our own undo produces, otherwise the guard
        // would fight the undo it just issued and loop forever.
        if (undoingRef.current) return;
        const range = protectedRangeRef.current;
        if (!range) return;
        const touchesSegment = ev.changes.some(
          (c) =>
            c.range.startLineNumber <= range.endLine && c.range.endLineNumber >= range.startLine,
        );
        if (!touchesSegment) return;
        undoingRef.current = true;
        editor.trigger('managed-segment', 'undo', null);
        undoingRef.current = false;
        flashSegmentNotice();
      });
      setEditorReady(true);
    },
    [flashSegmentNotice],
  );

  useEffect(() => {
    if (!editorReady) return;
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;
    const model = editor.getModel();
    if (!model) return;
    // Squad ships CRLF configs; keep the model's EOL aligned so getValue()
    // (and therefore the PUT payload) round-trips byte-identically.
    if (content.includes('\r\n')) {
      model.setEOL(monaco.editor.EndOfLineSequence.CRLF);
    }
    const range = isManagedAdmins ? managedSegmentLineRange(content) : null;
    protectedRangeRef.current = range;
    decorationsRef.current?.clear();
    decorationsRef.current = null;
    if (range) {
      decorationsRef.current = editor.createDecorationsCollection([
        {
          range: new monaco.Range(range.startLine, 1, range.endLine, 1),
          options: {
            isWholeLine: true,
            className: 'squad-managed-segment',
            linesDecorationsClassName: 'squad-managed-segment-gutter',
            hoverMessage: { value: 'управляется панелью' },
          },
        },
      ]);
    }
  }, [editorReady, content, isManagedAdmins]);

  useEffect(
    () => () => {
      if (segmentNoticeTimer.current) clearTimeout(segmentNoticeTimer.current);
    },
    [],
  );

  return { handleEditorMount, segmentNotice };
}
