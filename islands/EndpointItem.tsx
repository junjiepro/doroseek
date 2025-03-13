import { useCallback, useRef, useState } from "preact/hooks";
import type { EndpointListItem } from "../shared/api.ts";

function EndpointItem(
  { item, save }: {
    item: EndpointListItem;
    save: (
      item: EndpointListItem,
      setting: string | null,
      models: string[] | null,
      enabled: boolean,
    ) => void;
  },
) {
  const input = useRef<HTMLInputElement>(null);
  const modelsInput = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [editingModels, setEditingModels] = useState(false);
  const [busy, setBusy] = useState(false);
  const doSave = useCallback(() => {
    if (!input.current) return;
    setBusy(true);
    save(item, input.current.value, item.models, item.enabled);
  }, [item]);
  const cancelEdit = useCallback(() => {
    if (!input.current) return;
    setEditing(false);
    input.current.value = item.setting;
  }, []);
  const cancelEditModels = useCallback(() => {
    if (!modelsInput.current) return;
    setEditingModels(false);
    modelsInput.current.value = item.models?.join(",");
  }, []);
  const doDelete = useCallback(() => {
    const yes = confirm("Are you sure you want to delete this item?");
    if (!yes) return;
    setBusy(true);
    save(item, null, item.models, item.enabled);
  }, [item]);
  const doSaveEnabled = useCallback((enabled: boolean) => {
    setBusy(true);
    save(item, item.setting, item.models, enabled);
  }, [item]);
  const doSaveModels = useCallback(() => {
    if (!modelsInput.current) return;
    setBusy(true);
    // 去重
    const models = Array.from(
      new Set(
        modelsInput.current.value.replaceAll("，", ",").split(",").map((m) =>
          m.trim()
        ),
      ),
    );
    save(item, item.setting, models, item.enabled);
  }, [item]);

  const modelNames = item.models?.map((m) => m.split("@")[0]) || [];

  return (
    <div
      className="flex my-2 border-b border-gray-300 items-center min-h-16"
      {...{ "data-item-id": item.id! }}
    >
      {editing && (
        <>
          <input
            className="text-black border rounded w-full py-2 px-3 mr-4"
            ref={input}
            defaultValue={item.setting}
          />
          <button
            className="p-2 rounded mr-2 disabled:opacity-50"
            title="Save"
            onClick={doSave}
            disabled={busy}
          >
            💾
          </button>
          <button
            className="p-2 rounded disabled:opacity-50"
            title="Cancel"
            onClick={cancelEdit}
            disabled={busy}
          >
            🚫
          </button>
        </>
      )}
      {editingModels && (
        <>
          <input
            className="text-black border rounded w-full py-2 px-3 mr-4"
            ref={modelsInput}
            defaultValue={item.models?.join(",")}
            placeholder="alias1@model1,alias2@model2"
          />
          <button
            className="p-2 rounded mr-2 disabled:opacity-50"
            title="Save"
            onClick={doSaveModels}
            disabled={busy}
          >
            💾
          </button>
          <button
            className="p-2 rounded disabled:opacity-50"
            title="Cancel"
            onClick={cancelEditModels}
            disabled={busy}
          >
            🚫
          </button>
        </>
      )}
      {!editing && !editingModels && (
        <>
          <input
            type="checkbox"
            checked={item.enabled}
            disabled={busy}
            onChange={(e) => doSaveEnabled(e.currentTarget.checked)}
            className="mr-2"
          />
          <div className="flex flex-col w-full font-mono">
            <p>
              {item.name}
            </p>
            {modelNames.length > 0 && (
              <p className="text-xs opacity-50 leading-loose">
                {modelNames.map((name) => (
                  <div key={name} className="inline-block mr-2">
                    <button
                      type="button"
                      className="border rounded px-1 text-xs opacity-50 hover:opacity-100 data-[state=copied]:bg-green-500 data-[state=copied]:opacity-100 data-[state=copied]:text-white"
                      data-state="false"
                      onClick={(event) => {
                        navigator.clipboard.writeText(name);
                        const button = event.currentTarget as HTMLButtonElement;
                        button.dataset.state = "copied";
                        button.textContent = name + "✅";
                        setTimeout(() => {
                          button.dataset.state = "false";
                          button.textContent = name;
                        }, 2500);
                      }}
                    >
                      {name}
                    </button>
                  </div>
                ))}
              </p>
            )}
            <p className="text-xs opacity-50 leading-loose">
              {new Date(item.createdAt).toISOString()}
            </p>
          </div>
          <button
            className="p-2 mr-2 disabled:opacity-50"
            title="Edit"
            onClick={() => setEditing(true)}
            disabled={busy}
          >
            ✏️
          </button>
          <button
            className="p-2 mr-2 disabled:opacity-50"
            title="Edit models"
            onClick={() => setEditingModels(true)}
            disabled={busy}
          >
            🗂️
          </button>
          <button
            className="p-2 disabled:opacity-50"
            title="Delete"
            onClick={doDelete}
            disabled={busy}
          >
            🗑️
          </button>
        </>
      )}
    </div>
  );
}

export default EndpointItem;
