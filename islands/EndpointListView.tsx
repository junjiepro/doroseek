import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type {
  EndpointKey,
  EndpointList,
  EndpointListItem,
} from "../shared/api.ts";
import axios from "axios-web";
import EndpointItem from "./EndpointItem.tsx";
import EndpointKeyItem from "./EndpointKey.tsx";

interface LocalItemMutation {
  setting: string | null;
  name: string | null;
  endpoint: string | null;
  apiKey: string | null;
  models: string[] | null;
  enabled: boolean;
}
interface LocalKeyMutation {
  name: string | null;
  enabled: boolean;
}

export default function EndpointListView(
  props: { initialData: EndpointList; latency: number },
) {
  const [data, setData] = useState(props.initialData);
  const [dirty, setDirty] = useState(false);
  const localItemMutations = useRef(new Map<string, LocalItemMutation>());
  const [hasLocalItemMutations, setHasLocalItemMutations] = useState(false);
  const localKeyMutations = useRef(new Map<string, LocalKeyMutation>());
  const [hasLocalKeyMutations, setHasLocalKeyMutations] = useState(false);
  const busy = hasLocalItemMutations || hasLocalKeyMutations || dirty;
  const [adding, setAdding] = useState(false);

  const baseUrlInput = useRef<HTMLInputElement>(null);
  const apiKeyInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const url = new URL(window.location.href);
    const base = url.origin;
    const key = url.pathname.slice(1);

    baseUrlInput.current!.value = `${base}/api`;
    apiKeyInput.current!.value = key;

    let es = new EventSource(window.location.href);

    es.addEventListener("message", (e) => {
      const newData: EndpointList = JSON.parse(e.data);
      setData(newData);
      setDirty(false);
      setAdding(false);
    });

    es.addEventListener("error", async () => {
      es.close();
      const backoff = 10000 + Math.random() * 5000;
      await new Promise((resolve) => setTimeout(resolve, backoff));
      es = new EventSource(window.location.href);
    });
  }, []);

  useEffect(() => {
    (async () => {
      while (1) {
        const mutations = Array.from(localItemMutations.current);
        localItemMutations.current = new Map();
        setHasLocalItemMutations(false);

        if (mutations.length) {
          setDirty(true);
          const chunkSize = 10;
          for (let i = 0; i < mutations.length; i += chunkSize) {
            const chunk = mutations.slice(i, i + chunkSize).map((
              [id, mut],
            ) => ({
              id,
              setting: mut.setting,
              name: mut.name,
              endpoint: mut.endpoint,
              apiKey: mut.apiKey,
              models: mut.models,
              enabled: mut.enabled,
            }));
            while (true) {
              try {
                await axios.post(`${window.location.href}?type=item`, chunk);
                break;
              } catch {
                await new Promise((resolve) => setTimeout(resolve, 1000));
              }
            }
          }
        }

        const keyMutations = Array.from(localKeyMutations.current);
        localKeyMutations.current = new Map();
        setHasLocalKeyMutations(false);

        if (keyMutations.length) {
          setDirty(true);
          const chunkSize = 10;
          for (let i = 0; i < keyMutations.length; i += chunkSize) {
            const chunk = keyMutations.slice(i, i + chunkSize).map((
              [id, mut],
            ) => ({
              id,
              name: mut.name,
              parentId: "",
              enabled: mut.enabled,
            }));
            while (true) {
              try {
                await axios.post(`${window.location.href}?type=key`, chunk);
                break;
              } catch {
                await new Promise((resolve) => setTimeout(resolve, 1000));
              }
            }
          }
        }

        await new Promise((resolve) =>
          setTimeout(
            () => requestAnimationFrame(resolve), // pause when the page is hidden
            1000,
          )
        );
      }
    })();
  }, []);

  const addEndpointInput = useRef<HTMLInputElement>(null);
  const addEndpoint = useCallback(() => {
    const value = addEndpointInput.current!.value;
    if (!value) return;
    addEndpointInput.current!.value = "";

    const setting = value;
    const [name, endpoint, apiKey] = value.split("|", 3);

    const id = generateItemId();
    localItemMutations.current.set(id, {
      setting,
      name,
      endpoint,
      apiKey,
      models: [],
      enabled: true,
    });
    setHasLocalItemMutations(true);
    setAdding(true);
  }, []);

  const saveEndpoint = useCallback(
    (
      item: EndpointListItem,
      setting: string | null,
      models: string[] | null,
      enabled: boolean,
    ) => {
      if (!setting) {
        localItemMutations.current.set(item.id!, {
          setting: "",
          name: "",
          endpoint: "",
          apiKey: "",
          models: [],
          enabled,
        });
      } else {
        const [name, endpoint, apiKey] = setting.split("|", 3);
        localItemMutations.current.set(item.id!, {
          setting,
          name,
          endpoint,
          apiKey,
          models,
          enabled,
        });
      }
      setHasLocalItemMutations(true);
    },
    [],
  );

  const addKeyInput = useRef<HTMLInputElement>(null);
  const addKey = useCallback(() => {
    const value = addKeyInput.current!.value;
    if (!value) return;
    addKeyInput.current!.value = "";

    const id = generateKeyId();
    localKeyMutations.current.set(id, {
      name: value,
      enabled: true,
    });
    setHasLocalKeyMutations(true);
    setAdding(true);
  }, []);

  const saveKey = useCallback(
    (
      key: EndpointKey,
      name: string | null,
      enabled: boolean,
    ) => {
      if (!name) {
        localKeyMutations.current.set(key.id!, {
          name: "",
          enabled,
        });
      } else {
        localKeyMutations.current.set(key.id!, {
          name,
          enabled,
        });
      }
      setHasLocalKeyMutations(true);
    },
    [],
  );

  return (
    <div className="flex gap-2 w-full items-center justify-center py-4 xl:py-16 px-2">
      <div className="rounded w-full xl:max-w-xl">
        <div className="flex flex-col gap-4 pb-4">
          <div className="flex flex-row gap-2 items-center">
            <h1 className="font-bold text-xl">
              <span className="relative inline-block before:absolute before:-inset-1 before:block before:-skew-y-3 before:bg-pink-500">
                <span className="relative text-white">
                  Doroseek
                </span>
              </span>
            </h1>
            <div
              className={`inline-block h-2 w-2 ${
                busy ? "bg-yellow-600" : "bg-green-600"
              }`}
              style={{ borderRadius: "50%" }}
            >
            </div>
          </div>
          <div className="flex">
            <p className="opacity-50 text-sm">
              Access all endpoints with the same base URL and API key.
            </p>
          </div>
          <div className="flex">
            <p className="opacity-50 text-sm">
              Save this page to avoid losing your setting. Share this page to
              collaborate with others.
            </p>
          </div>
          <div className="flex">
            <div className="flex items-center text-md w-28">Base URL</div>
            <input
              className="text-black border rounded w-full py-1 px-3"
              ref={baseUrlInput}
              onClick={() => baseUrlInput.current?.select()}
              readonly
            />
          </div>
          <div className="flex">
            <div className="flex items-center text-md w-28">Admin Key</div>
            <input
              className="text-black border rounded w-full py-1 px-3"
              ref={apiKeyInput}
              onClick={() => apiKeyInput.current?.select()}
              readonly
            />
          </div>
        </div>
        <div className="flex flex-col gap-4 pb-4">
          <div className="flex flex-row gap-2 items-center">
            <h2 className="font-bold text-lg">Keys</h2>
          </div>
          <div className="flex">
            <input
              className="text-black border rounded w-full py-2 px-3 mr-4"
              placeholder="Input the name of the key"
              ref={addKeyInput}
            />
            <button
              className="p-2 bg-pink-500 text-white rounded disabled:opacity-50"
              onClick={addKey}
              disabled={adding}
            >
              Generate
            </button>
          </div>
        </div>
        <div>
          {data.keys.map((key) => (
            <EndpointKeyItem
              key={key.id! + ":" + key.versionstamp!}
              item={key}
              save={saveKey}
            />
          ))}
        </div>
        <div className="flex flex-col gap-4 py-4">
          <div className="flex flex-row gap-2 items-center">
            <h2 className="font-bold text-lg">Endpoints</h2>
          </div>
          <div className="flex">
            <input
              className="text-black border rounded w-full py-2 px-3 mr-4"
              placeholder="Add an endpoint (name|endpoint|apikey)"
              ref={addEndpointInput}
            />
            <button
              className="p-2 bg-pink-500 text-white rounded disabled:opacity-50"
              onClick={addEndpoint}
              disabled={adding}
            >
              Add
            </button>
          </div>
          <div className="flex">
            <p className="opacity-50 text-sm">
              Endpoint format: name|endpoint|apikey
            </p>
          </div>
        </div>
        <div>
          {data.items.map((item) => (
            <EndpointItem
              key={item.id! + ":" + item.versionstamp!}
              item={item}
              save={saveEndpoint}
            />
          ))}
        </div>
        <div className="pt-6 opacity-50 text-sm">
          <p>
            Initial data fetched in {props.latency}ms
          </p>
          <p>
            <a
              href="https://github.com/junjiepro/Doroseek"
              className="underline"
            >
              Source code
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}

function generateItemId(): string {
  return `${Date.now()}-${crypto.randomUUID()}`;
}

function generateKeyId(): string {
  return `doro-${crypto.randomUUID()}`;
}
