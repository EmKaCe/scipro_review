import { marked } from "marked";

const testMarkdown = `## Positive Observations

<!-- sentiment:positive -->

### Code Formatting

**Formatting is done well**

- [x] concise code

<!-- /sentiment:positive -->`;

const html = marked.parse(testMarkdown, { async: false }) as string;
console.log("HTML output:");
console.log(html);
console.log("\nHas h3:", html.includes("<h3>"));
console.log("Has comment:", html.includes("<!-- sentiment:positive -->"));
console.log("Has h2:", html.includes("<h2>"));
console.log("Has li:", html.includes("<li>"));
console.log("Has strong:", html.includes("<strong>"));
