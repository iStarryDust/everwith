/**
 * 下载中文流式识别模型（zipformer2，int8 量化）。
 *
 * 源：HuggingFace 的 csukuangfj 仓库，国内用 hf-mirror 镜像。
 * 只下识别必需的四件：编码器、解码器、连接器、词表。
 */
const fs = require('fs');
const path = require('path');

const REPO = 'csukuangfj/sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30';
const FILES = ['encoder.int8.onnx', 'decoder.onnx', 'joiner.int8.onnx', 'tokens.txt'];
const HOSTS = ['https://hf-mirror.com', 'https://huggingface.co'];
const OUT = path.join(process.env.USERPROFILE || 'C:/Users/11657', '.dsh', 'spoon-companion', 'models', 'zh-streaming');

fs.mkdirSync(OUT, { recursive: true });

async function head(url) {
  const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return Number(res.headers.get('content-length') || 0);
}

async function download(url, dest, total) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30 * 60 * 1000) });
  if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
  const tmp = dest + '.part';
  const out = fs.createWriteStream(tmp);
  let got = 0;
  let lastPct = -1;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.write(Buffer.from(value));
    got += value.length;
    const pct = total ? Math.floor((got / total) * 100) : 0;
    if (pct !== lastPct && pct % 10 === 0) {
      lastPct = pct;
      process.stdout.write(`  ${path.basename(dest)}  ${pct}%  (${(got / 1048576).toFixed(1)} MB)\n`);
    }
  }
  await new Promise((r) => out.end(r));
  fs.renameSync(tmp, dest);
  return got;
}

(async () => {
  console.log('目标目录: ' + OUT + '\n');

  let host = '';
  for (const h of HOSTS) {
    try {
      const url = `${h}/${REPO}/resolve/main/encoder.int8.onnx`;
      const size = await head(url);
      host = h;
      console.log('可用源: ' + h + '  (encoder ' + (size / 1048576).toFixed(1) + ' MB)\n');
      break;
    } catch (e) {
      console.log('源不可用: ' + h + '  (' + e.message + ')');
    }
  }
  if (!host) {
    console.log('\n✗ 两个源都不可达');
    process.exit(1);
  }

  for (const f of FILES) {
    const dest = path.join(OUT, f);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 1024) {
      console.log('已有，跳过: ' + f);
      continue;
    }
    const url = `${host}/${REPO}/resolve/main/${f}`;
    process.stdout.write('下载 ' + f + '\n');
    const t0 = Date.now();
    const n = await download(url, dest, 0);
    console.log(`  完成 ${f}  ${(n / 1048576).toFixed(1)} MB  用时 ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
  }

  console.log('全部就绪:');
  for (const f of FILES) {
    const p = path.join(OUT, f);
    const ok = fs.existsSync(p);
    console.log('  ' + (ok ? '✓' : '✗') + ' ' + f + (ok ? '  ' + (fs.statSync(p).size / 1048576).toFixed(1) + ' MB' : ''));
  }
})();
