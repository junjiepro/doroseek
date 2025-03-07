import { Head } from "$fresh/runtime.ts";

export default function Home() {
  return (
    <>
      <Head>
        <title>Doroseek</title>
      </Head>
      <div
        class="relative p-4 mx-auto max-w-screen-md dark:text-white h-[100vh] overflow-auto"
        style={{
          scrollbarWidth: "none",
        }}
      >
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
              </div>
              <div className="flex flex-row gap-2 items-center">
                <h2 className="font-bold text-lg">Not found</h2>
              </div>
              <div className="flex">
                <p className="opacity-50 text-sm">
                  This page is not found, please check the URL. Input a valid
                  Admin Key to access the setting page.
                </p>
              </div>
            </div>
            <div className="pt-6 opacity-50 text-sm">
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
      </div>
    </>
  );
}
