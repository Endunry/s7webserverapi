const fs = require("fs");
const path = require("path");

const filePath = path.join(
  __dirname,
  "..",
  "dist",
  "scripts",
  "generateDBStructure.js"
);
const shebang = "#!/usr/bin/env node\n";
const content = fs.readFileSync(filePath, "utf8");

if (!content.startsWith(shebang)) {
  fs.writeFileSync(filePath, shebang + content);
  console.log("Shebang added to cli.js");
} else {
  console.log("Shebang already present.");
}
