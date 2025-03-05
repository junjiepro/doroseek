import { PageProps } from "$fresh/server.ts";
import { AuroraBackground } from "../islands/AuroraBackground.tsx";

export default function Layout({ Component }: PageProps) {
  return (
    <AuroraBackground>
      <Component />
    </AuroraBackground>
  );
}
