'use client';
import type { OnMount } from '@monaco-editor/react';
import { Button, TextInput } from '@/components/ui';
import { MonacoEditor } from './monaco';

/**
 * Просмотр и правка одного файла конфигурации.
 *
 * Файл открывается только для чтения; правка включается кнопкой «Изменить» в
 * правом нижнем углу редактора. Панель сохранения показывается лишь в режиме
 * правки — в режиме просмотра сохранять нечего, и пустая строка полей только
 * отвлекала бы.
 *
 * @param editing Правка разрешена оператором для текущего файла.
 * @param onStartEditing Снять режим только для чтения.
 * @param locked Файл неизменяем в принципе (managed-сегмент): кнопки
 *   «Изменить» нет вообще, потому что нажимать её было бы не на что.
 */
export function EditorView(props: {
  content: string;
  onChange: (v: string) => void;
  commitMessage: string;
  setCommitMessage: (v: string) => void;
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
  editing: boolean;
  onStartEditing: () => void;
  locked?: boolean;
  onMount?: OnMount;
}) {
  const readOnly = props.locked || !props.editing;

  return (
    <>
      {props.editing && !props.locked ? (
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <TextInput
            value={props.commitMessage}
            onChange={(e) => props.setCommitMessage(e.target.value)}
            placeholder="Комментарий к изменению (необязательно)"
            aria-label="Комментарий к изменению"
            maxLength={500}
            className="flex-1"
          />
          <Button onClick={props.onDiscard} disabled={props.saving}>
            Отмена
          </Button>
          <Button
            variant="primary"
            onClick={props.onSave}
            loading={props.saving}
            disabled={!props.dirty}
          >
            Сохранить
          </Button>
        </div>
      ) : null}
      <div className="relative">
        <MonacoEditor
          height="65vh"
          defaultLanguage="ini"
          theme="vs-dark"
          value={props.content}
          onChange={(v) => props.onChange(v ?? '')}
          onMount={props.onMount}
          options={{
            minimap: { enabled: false },
            fontSize: 13,
            wordWrap: 'on',
            renderWhitespace: 'boundary',
            scrollBeyondLastLine: false,
            readOnly,
          }}
        />
        {readOnly && !props.locked ? (
          <div className="absolute right-4 bottom-4 z-10">
            <Button variant="success" size="sm" onClick={props.onStartEditing}>
              Изменить
            </Button>
          </div>
        ) : null}
      </div>
    </>
  );
}
