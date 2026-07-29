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
      ? 'helper-look 2.8s ease-in-out infinite'
      : mood === 'upload'
        ? 'helper-scan-look 2.1s ease-in-out infinite'
        : mood === 'success'
          ? 'helper-happy-eyes 1.9s ease-in-out infinite'
          : mood === 'talk'
            ? 'helper-listen 3.2s ease-in-out infinite'
            : 'helper-glance 6.8s ease-in-out infinite';
  const sleepEyes =
    mood === 'sleep'
      ? `
      #helper-source path:nth-of-type(3),
      #helper-source path:nth-of-type(4),
      #helper-source path:nth-of-type(10),
      #helper-source path:nth-of-type(11) {
        animation: helper-sleep-eyes 4.4s ease-in-out infinite;
        transform-box: fill-box;
        transform-origin: center;
      }`
      : `
      #helper-source path:nth-of-type(3),
      #helper-source path:nth-of-type(4) {
        animation: helper-blink 6.8s linear infinite;
        transform-box: fill-box;
        transform-origin: center;
      }
      #helper-source path:nth-of-type(10),
      #helper-source path:nth-of-type(11) {
        animation: ${pupilAnimation}, helper-blink 6.8s linear infinite;
        transform-box: fill-box;
        transform-origin: center;
      }`;
  const eyelidAnimation =
    mood === 'sleep'
      ? 'helper-sleep-eyelids 4.4s ease-in-out infinite'
      : 'helper-eyelids 6.8s linear infinite';
  return `
    #helper-source {
      animation: ${helperMotion[mood]};
      transform-box: fill-box;
      transform-origin: center;
    }
    #helper-eyelids {
      animation: ${eyelidAnimation};
      opacity: 0;
    }
    #helper-eyelids .helper-eye-cover {
      fill: #010101;
      stroke: none;
    }
    #helper-eyelids path {
      fill: none;
      stroke-linecap: round;
      stroke-linejoin: round;
      stroke-width: 185px;
    }
    #helper-eyelid-left { stroke: #ffffff; }
    #helper-eyelid-right { stroke: #ffffff; }
    ${sleepEyes}
    @keyframes helper-idle {
      0%, 100% { transform: translateY(18px) rotate(-.35deg) scale(1); }
      24% { transform: translateY(-12px) rotate(.25deg) scale(1.006, .997); }
      52% { transform: translateY(-42px) rotate(.45deg) scale(1.012, .992); }
      76% { transform: translateY(-10px) rotate(-.15deg) scale(1.006, .998); }
    }
    @keyframes helper-talk {
      0%, 100% { transform: translateY(16px) rotate(-1.2deg) scale(1); }
      18% { transform: translateY(-24px) rotate(.8deg) scale(1.012, .992); }
      38% { transform: translateY(-76px) rotate(1.4deg) scale(1.02, .985); }
      58% { transform: translateY(-28px) rotate(-.6deg) scale(1.008); }
      76% { transform: translateY(-62px) rotate(1deg) scale(1.017, .989); }
    }
    @keyframes helper-search {
      0%, 100% { transform: translate(-80px, 10px) rotate(-1.1deg); }
      25% { transform: translate(-24px, -28px) rotate(-.3deg) scale(1.008); }
      50% { transform: translate(82px, 4px) rotate(1.1deg) scale(1.014); }
      75% { transform: translate(18px, -36px) rotate(.25deg) scale(1.008); }
    }
    @keyframes helper-upload {
      0%, 100% { transform: translateY(18px) scale(1); }
      20% { transform: translateY(-18px) scale(1.008, .994); }
      48% { transform: translateY(-52px) scale(1.025, .982); }
      72% { transform: translateY(-12px) scale(1.012, .992); }
    }
    @keyframes helper-sleep {
      0%, 100% { transform: translateY(24px) rotate(-1.4deg) scale(1); }
      45% { transform: translateY(48px) rotate(-1.1deg) scale(1.018, .979); }
      58% { transform: translateY(51px) rotate(-1.1deg) scale(1.02, .976); }
    }
    @keyframes helper-success {
      0%, 100% { transform: translateY(24px) rotate(-2.2deg) scale(1); }
      16% { transform: translateY(-42px) rotate(1.8deg) scale(1.035, .97); }
      34% { transform: translateY(-128px) rotate(3.2deg) scale(1.055, .955); }
      52% { transform: translateY(-20px) rotate(-1.5deg) scale(1.015, .988); }
      68% { transform: translateY(-76px) rotate(2.2deg) scale(1.035, .972); }
      82% { transform: translateY(2px) rotate(-1deg) scale(1.01, .993); }
    }
    @keyframes helper-glance {
      0%, 24%, 100% { translate: 0 0; }
      29%, 39% { translate: -88px 12px; }
      45%, 55% { translate: 82px -8px; }
      62%, 66% { translate: 0 0; }
      70%, 78% { translate: -42px -18px; }
    }
    @keyframes helper-look {
      0%, 8%, 100% { translate: -150px 0; }
      34%, 42% { translate: 0 -35px; }
      66%, 78% { translate: 150px 12px; }
    }
    @keyframes helper-scan-look {
      0%, 100% { translate: 0 -88px; }
      48%, 58% { translate: 0 88px; }
    }
    @keyframes helper-happy-eyes {
      0%, 100% { translate: 0 0; }
      28%, 42% { translate: 0 -28px; }
      62%, 76% { translate: 0 18px; }
    }
    @keyframes helper-listen {
      0%, 26%, 100% { translate: 0 0; }
      34%, 47% { translate: -62px -12px; }
      58%, 72% { translate: 54px 8px; }
    }
    @keyframes helper-blink {
      0%, 28%, 33%, 35%, 39%, 65%, 70%, 100% { scale: 1 1; }
      29.4%, 31.6%, 36.4%, 38%, 66.4%, 68.6% { scale: 1 .001; }
    }
    @keyframes helper-eyelids {
      0%, 28.6%, 32.4%, 35.6%, 38.6%, 65.6%, 69.4%, 100% { opacity: 0; }
      29.4%, 31.6%, 36.4%, 38%, 66.4%, 68.6% { opacity: 1; }
    }
    @keyframes helper-sleep-eyes {
      0%, 12%, 100% { scale: 1 1; }
      19%, 91% { scale: 1 .001; }
    }
    @keyframes helper-sleep-eyelids {
      0%, 13%, 97%, 100% { opacity: 0; }
      20%, 91% { opacity: 1; }
    }
    @media (prefers-reduced-motion: reduce) {
      #helper-source,
      #helper-source path,
      #helper-eyelids { animation: none !important; }
      #helper-eyelids { opacity: 0; }
    }
  `;
}

const helperEyelids = `
   <g id="helper-eyelids">
    <ellipse class="helper-eye-cover" cx="2886" cy="6370" rx="1005" ry="1005"/>
    <ellipse class="helper-eye-cover" cx="6914" cy="6355" rx="1005" ry="1005"/>
    <path id="helper-eyelid-left" d="M2150 6380 Q2890 6820 3630 6380"/>
    <path id="helper-eyelid-right" d="M6180 6365 Q6915 6805 7650 6365"/>
   </g>
`;

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
    .replace(/<g id="_\d+">/, '<g id="helper-source">')
    .replace(/ {2}<\/g>(\r?\n <\/g>\r?\n<\/svg>)/, `${helperEyelids}  </g>$1`);
  await writeFile(path.join(targetDirectory, `helper-${mood}.svg`), output, 'utf8');
}
