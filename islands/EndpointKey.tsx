import { useCallback, useRef, useState } from "preact/hooks";
import type { EndpointKey } from "../shared/api.ts";

function EndpointKey(
  { item, save }: {
    item: EndpointKey;
    save: (
      item: EndpointKey,
      name: string | null,
      enabled: boolean,
    ) => void;
  },
) {
  const input = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const doSave = useCallback(() => {
    if (!input.current) return;
    setBusy(true);
    save(item, input.current.value, item.enabled);
  }, [item]);
  const cancelEdit = useCallback(() => {
    if (!input.current) return;
    setEditing(false);
    input.current.value = item.name;
  }, []);
  const doDelete = useCallback(() => {
    const yes = confirm("Are you sure you want to delete this item?");
    if (!yes) return;
    setBusy(true);
    save(item, null, item.enabled);
  }, [item]);
  const doSaveEnabled = useCallback((enabled: boolean) => {
    setBusy(true);
    save(item, item.name, enabled);
  }, [item]);

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
            defaultValue={item.name}
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
      {!editing && (
        <>
          <input
            type="checkbox"
            checked={item.enabled}
            disabled={busy}
            onChange={(e) => doSaveEnabled(e.currentTarget.checked)}
            className="mr-2"
          />
          <div className="flex flex-col w-full font-mono group">
            <p>
              {item.name}
            </p>
            <p className="text-xs opacity-50 leading-loose">
              <button
                type="button"
                className="w-16 truncate group-hover:w-fit border rounded px-1 text-xs opacity-50 hover:opacity-100 data-[state=copied]:bg-green-500 data-[state=copied]:opacity-100 data-[state=copied]:text-white"
                data-state="false"
                onClick={(event) => {
                  navigator.clipboard.writeText(item.id!);
                  const button = event.currentTarget as HTMLButtonElement;
                  button.dataset.state = "copied";
                  button.textContent = item.id! + "✅";
                  setTimeout(() => {
                    button.dataset.state = "false";
                    button.textContent = item.id!;
                  }, 2500);
                }}
              >
                {item.id}
              </button>
            </p>
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

export default EndpointKey;
