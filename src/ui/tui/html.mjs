// src/ui/tui/html.mjs — htm 绑定 React.createElement,免 JSX 构建步骤。
import React from "react";
import htm from "htm";

export const html = htm.bind(React.createElement);
