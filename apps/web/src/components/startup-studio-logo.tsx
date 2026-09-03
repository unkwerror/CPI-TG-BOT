import Image from 'next/image';

export function StartupStudioLogo({
  compact = false,
  priority = false,
  className = '',
}: {
  compact?: boolean;
  priority?: boolean;
  className?: string;
}) {
  return (
    <span className={`startup-logo${compact ? ' startup-logo--compact' : ''} ${className}`.trim()}>
      <Image
        src="/brand/startup-studio-nsu.svg"
        alt="Стартап-студия НГУ"
        width={640}
        height={640}
        priority={priority}
        unoptimized
      />
    </span>
  );
}
