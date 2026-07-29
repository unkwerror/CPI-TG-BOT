import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDirectory = path.join(root, 'assets');
const targetDirectory = path.join(root, 'apps/web/public/cats');

const motionByCat = {
  1: 'source-scan 2.2s ease-in-out infinite',
  2: 'source-sit 3.8s ease-in-out infinite',
  3: 'source-celebrate 1.8s ease-in-out infinite',
  4: 'source-float 2.4s ease-in-out infinite',
  5: 'source-sleep 4.6s ease-in-out infinite',
  6: 'source-talk 2.1s ease-in-out infinite',
  7: 'source-search 2.8s ease-in-out infinite',
};

function animationStyle(index) {
  const detail =
    index === 6
      ? `
      #assistant-source path:nth-of-type(11) {
        animation: source-antenna 1.8s ease-in-out infinite;
        transform-box: fill-box;
        transform-origin: center;
      }
      #assistant-source path:nth-of-type(16) {
        animation: source-mouth 720ms ease-in-out infinite;
        transform-box: fill-box;
        transform-origin: center;
      }
      #assistant-source path:nth-of-type(19),
      #assistant-source path:nth-of-type(20) {
        animation: source-blink 5s linear infinite;
        transform-box: fill-box;
        transform-origin: center;
      }`
      : '';
  return `
    #assistant-source {
      animation: ${motionByCat[index]};
      transform-box: fill-box;
      transform-origin: center;
    }
    ${detail}
    @keyframes source-scan {
      0%, 100% { transform: translateY(0) scale(1); }
      50% { transform: translateY(-90px) scale(1.018); }
    }
    @keyframes source-sit {
      0%, 100% { transform: translateY(0) scaleY(1); }
      50% { transform: translateY(-45px) scaleY(1.012); }
    }
    @keyframes source-celebrate {
      0%, 100% { transform: translateY(15px) rotate(-1.5deg); }
      50% { transform: translateY(-115px) rotate(2deg); }
    }
    @keyframes source-float {
      0%, 100% { transform: translateY(20px) rotate(-1.2deg); }
      50% { transform: translateY(-100px) rotate(1.8deg); }
    }
    @keyframes source-sleep {
      0%, 100% { transform: translateY(0) scale(1); }
      50% { transform: translateY(35px) scale(1.012, .987); }
    }
    @keyframes source-talk {
      0%, 100% { transform: translateY(10px) rotate(-.6deg); }
      50% { transform: translateY(-55px) rotate(.8deg); }
    }
    @keyframes source-search {
      0%, 100% { transform: translateX(-65px) rotate(-.8deg); }
      50% { transform: translateX(65px) rotate(.8deg); }
    }
    @keyframes source-antenna {
      0%, 100% { transform: rotate(-2deg); }
      50% { transform: rotate(3deg); }
    }
    @keyframes source-mouth {
      0%, 100% { transform: scaleY(.94); }
      50% { transform: scaleY(1.08); }
    }
    @keyframes source-blink {
      0%, 43%, 47%, 76%, 80%, 100% { transform: scaleY(1); }
      45%, 78% { transform: scaleY(.2); }
    }
    @media (prefers-reduced-motion: reduce) {
      #assistant-source,
      #assistant-source path { animation: none !important; }
    }
  `;
}

const helperMotion = {
  idle: 'helper-idle 3.6s ease-in-out infinite',
  talk: 'helper-talk 1.8s ease-in-out infinite',
  search: 'helper-search 2.6s ease-in-out infinite',
  upload: 'helper-upload 2.1s ease-in-out infinite',
  sleep: 'helper-sleep 4.4s ease-in-out infinite',
  success: 'helper-success 1.7s ease-in-out infinite',
};

function helperStyle(mood) {
  const pupilAnimation =
    mood === 'search'
      ? 'helper-look 2.4s ease-in-out infinite'
      : mood === 'upload'
        ? 'helper-scan-look 1.7s ease-in-out infinite'
        : mood === 'success'
          ? 'helper-happy-eyes 1.7s ease-in-out infinite'
          : 'helper-glance 5.4s ease-in-out infinite';
  const sleepEyes =
    mood === 'sleep'
      ? `
      #helper-source path:nth-of-type(3),
      #helper-source path:nth-of-type(4),
      #helper-source path:nth-of-type(9),
      #helper-source path:nth-of-type(10) {
        animation: helper-sleep-eyes 4.4s ease-in-out infinite;
        transform-box: fill-box;
        transform-origin: center;
      }`
      : `
      #helper-source path:nth-of-type(9),
      #helper-source path:nth-of-type(10) {
        animation: ${pupilAnimation};
        transform-box: fill-box;
        transform-origin: center;
      }`;
  return `
    #helper-source {
      animation: ${helperMotion[mood]};
      transform-box: fill-box;
      transform-origin: center;
    }
    ${sleepEyes}
    @keyframes helper-idle {
      0%, 100% { transform: translateY(12px) scale(1); }
      50% { transform: translateY(-30px) scale(1.008); }
    }
    @keyframes helper-talk {
      0%, 100% { transform: translateY(12px) rotate(-.7deg); }
      50% { transform: translateY(-65px) rotate(.9deg); }
    }
    @keyframes helper-search {
      0%, 100% { transform: translateX(-55px) rotate(-.6deg); }
      50% { transform: translateX(55px) rotate(.6deg); }
    }
    @keyframes helper-upload {
      0%, 100% { transform: translateY(10px) scale(1); }
      50% { transform: translateY(-35px) scale(1.018); }
    }
    @keyframes helper-sleep {
      0%, 100% { transform: translateY(24px) rotate(-1.2deg) scale(1); }
      50% { transform: translateY(48px) rotate(-1.2deg) scale(1.012, .985); }
    }
    @keyframes helper-success {
      0%, 100% { transform: translateY(20px) rotate(-2deg); }
      50% { transform: translateY(-105px) rotate(2.5deg); }
    }
    @keyframes helper-glance {
      0%, 38%, 100% { transform: translateX(0); }
      44%, 54% { transform: translateX(-90px); }
      62%, 72% { transform: translateX(90px); }
    }
    @keyframes helper-look {
      0%, 100% { transform: translateX(-155px); }
      50% { transform: translateX(155px); }
    }
    @keyframes helper-scan-look {
      0%, 100% { transform: translateY(-85px) scale(.96); }
      50% { transform: translateY(85px) scale(1.04); }
    }
    @keyframes helper-happy-eyes {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.1); }
    }
    @keyframes helper-sleep-eyes {
      0%, 16%, 100% { transform: scaleY(1); }
      24%, 90% { transform: scaleY(.12); }
    }
    @media (prefers-reduced-motion: reduce) {
      #helper-source,
      #helper-source path { animation: none !important; }
    }
  `;
}

await mkdir(targetDirectory, { recursive: true });
for (let index = 1; index <= 7; index += 1) {
  const source = await readFile(path.join(sourceDirectory, `коты каталисту${index}.svg`), 'utf8');
  const output = source
    .replace('</style>', `${animationStyle(index)}\n   </style>`)
    .replace(/<g id="_\d+">/, '<g id="assistant-source">');
  await writeFile(path.join(targetDirectory, `cat-${index}.svg`), output, 'utf8');
}

const helperSource = await readFile(path.join(sourceDirectory, 'коты каталисту1.svg'), 'utf8');
for (const mood of Object.keys(helperMotion)) {
  const output = helperSource
    .replace('</style>', `${helperStyle(mood)}\n   </style>`)
    .replace(/<g id="_\d+">/, '<g id="helper-source">');
  await writeFile(path.join(targetDirectory, `helper-${mood}.svg`), output, 'utf8');
}
