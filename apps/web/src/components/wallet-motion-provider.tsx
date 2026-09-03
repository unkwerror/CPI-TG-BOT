'use client';

import { LazyMotion, MotionConfig, domAnimation } from 'motion/react';
import type { ReactNode } from 'react';

export function WalletMotionProvider({ children }: { children: ReactNode }) {
  return (
    <LazyMotion features={domAnimation} strict>
      <MotionConfig
        reducedMotion="user"
        transition={{ type: 'spring', stiffness: 430, damping: 36, mass: 0.8 }}
      >
        {children}
      </MotionConfig>
    </LazyMotion>
  );
}
