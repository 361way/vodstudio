const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const packageJsonPath = path.join(rootDir, 'package.json');
const distDir = path.join(rootDir, 'dist');
const sourcePath = path.join(distDir, 'index.html');

function fail(message) {
  console.error(`[copy-versioned-build] ${message}`);
  process.exit(1);
}

if (!fs.existsSync(packageJsonPath)) {
  fail(`找不到 package.json: ${packageJsonPath}`);
}

if (!fs.existsSync(sourcePath)) {
  fail(`找不到构建产物: ${sourcePath}`);
}

const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const version = String(packageJson.version || '').trim();
if (!version) {
  fail('package.json 中缺少 version 字段');
}

const outputName = `VodStudio-V${version}.html`;
const outputPath = path.join(distDir, outputName);

fs.copyFileSync(sourcePath, outputPath);
console.log(`[copy-versioned-build] ${path.relative(rootDir, sourcePath)} -> ${path.relative(rootDir, outputPath)}`);
