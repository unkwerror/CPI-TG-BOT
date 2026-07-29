import Image from 'next/image';

export type CatMood = 'idle' | 'talk' | 'search' | 'upload' | 'sleep' | 'success';

const cats: Record<CatMood, { src: string; alt: string }> = {
  idle: { src: '/cats/helper-idle.svg', alt: 'Кот-помощник спокойно ждёт рядом' },
  talk: { src: '/cats/helper-talk.svg', alt: 'Кот-помощник подсказывает следующий шаг' },
  search: { src: '/cats/helper-search.svg', alt: 'Кот-помощник внимательно ищет' },
  upload: { src: '/cats/helper-upload.svg', alt: 'Кот-помощник следит за загрузкой' },
  sleep: { src: '/cats/helper-sleep.svg', alt: 'Кот-помощник отдыхает' },
  success: { src: '/cats/helper-success.svg', alt: 'Кот-помощник празднует успех' },
};

export function CatAssistant({
  mood,
  message,
  title = 'Кот-помощник',
  compact = false,
  live = false,
  className = '',
}: {
  mood: CatMood;
  message: string;
  title?: string;
  compact?: boolean;
  live?: boolean;
  className?: string;
}) {
  const cat = cats[mood];
  return (
    <aside
      className={`cat-assistant cat-assistant--${mood}${compact ? ' cat-assistant--compact' : ''} ${className}`.trim()}
      aria-live={live ? 'polite' : undefined}
    >
      <div className="cat-assistant__copy">
        <span className="cat-assistant__name">
          <i aria-hidden="true" />
          {title}
        </span>
        <p>{message}</p>
      </div>
      <div className="cat-assistant__art" aria-hidden="true">
        <span className="cat-assistant__halo" />
        <span className="cat-assistant__orbit">
          <i />
          <i />
          <i />
        </span>
        {mood === 'search' ? (
          <span className="cat-assistant__radar">
            <i />
            <i />
            <i />
          </span>
        ) : null}
        {mood === 'upload' ? <span className="cat-assistant__scan-beam" /> : null}
        <span className="cat-assistant__pose" key={mood}>
          <Image src={cat.src} alt="" width={300} height={300} priority unoptimized />
        </span>
        {mood === 'talk' ? (
          <span className="cat-assistant__talk-dots">
            <i />
            <i />
            <i />
          </span>
        ) : null}
        {mood === 'sleep' ? (
          <span className="cat-assistant__sleep-marks">
            <i>z</i>
            <i>z</i>
            <i>z</i>
          </span>
        ) : null}
        {mood === 'success' ? (
          <span className="cat-assistant__sparkles">
            <i>✦</i>
            <i>✦</i>
            <i>✦</i>
          </span>
        ) : null}
      </div>
      <span className="sr-only">{cat.alt}</span>
    </aside>
  );
}
