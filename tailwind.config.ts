import { type Config } from "tailwindcss";

// 手动实现颜色展平函数
function flattenColorPalette(
  colors: Record<string, any>
): Record<string, string> {
  const result: Record<string, string> = {};

  function flatten(obj: Record<string, any>, prefix = "") {
    Object.keys(obj).forEach((key) => {
      const value = obj[key];
      if (typeof value === "string") {
        result[`${prefix}${key}`] = value; // 直接存储颜色值
      } else if (typeof value === "object" && value !== null) {
        flatten(value, `${prefix}${key}-`); // 递归处理嵌套对象
      }
    });
  }

  flatten(colors);
  return result;
}

export default {
  content: ["{routes,islands,components}/**/*.{ts,tsx}"],
  theme: {
    extend: {
      animation: {
        aurora: "aurora 60s linear infinite",
      },
      keyframes: {
        aurora: {
          from: {
            backgroundPosition: "50% 50%, 50% 50%",
          },
          to: {
            backgroundPosition: "350% 50%, 350% 50%",
          },
        },
      },
    },
  },
  plugins: [addVariablesForColors],
} satisfies Config;

// This plugin adds each Tailwind color as a global CSS variable, e.g. var(--gray-200).
function addVariablesForColors({ addBase, theme }: any) {
  const allColors = flattenColorPalette(theme("colors"));
  const newVars = Object.fromEntries(
    Object.entries(allColors).map(([key, val]) => [`--${key}`, val])
  );

  addBase({
    ":root": newVars,
  });
}
