'use client';

import { useState } from 'react';

export function isCatalystTee(product: { slug?: string; title: string }): boolean {
  return (
    product.slug === 't-shirt-catalyst' ||
    /футболк.*catalyst|catalyst.*футболк/iu.test(product.title)
  );
}

export function CatalystTeeGallery({ color }: { color: 'dark' | 'light' }) {
  const [view, setView] = useState<'front' | 'back'>('front');
  return (
    <div className="catalyst-gallery">
      <div className="catalyst-gallery__top">
        <span>CATALYST × НГУ</span>
        <span>MERCH / 01</span>
      </div>
      <div className="catalyst-gallery__stage">
        <span className="catalyst-gallery__word" aria-hidden="true">
          MAKE
          <br />
          IT REAL.
        </span>
        <img
          key={color + view}
          src={'/merch/tee-' + color + '-' + view + '.webp'}
          alt={
            (color === 'dark' ? 'Тёмная' : 'Светлая') +
            ' футболка Catalyst, ' +
            (view === 'front' ? 'спереди' : 'сзади')
          }
        />
        <span className="catalyst-gallery__stamp" aria-hidden="true">
          ИДЕИ
          <br />В ДЕЛО ↗
        </span>
      </div>
      <div className="catalyst-gallery__views" role="group" aria-label="Ракурс футболки">
        <button type="button" aria-pressed={view === 'front'} onClick={() => setView('front')}>
          01 / Спереди
        </button>
        <button type="button" aria-pressed={view === 'back'} onClick={() => setView('back')}>
          02 / Сзади
        </button>
      </div>
    </div>
  );
}

export function CatalystTeeOptions({
  color,
  size,
  onColorChange,
  onSizeChange,
  disabled,
}: {
  color: 'dark' | 'light';
  size: string;
  onColorChange: (color: 'dark' | 'light') => void;
  onSizeChange: (size: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="catalyst-options">
      <p className="catalyst-options__intro">
        Для тех, кто превращает идеи в проекты. Фирменная футболка с маскотом стартап-студии.
      </p>
      <fieldset disabled={disabled}>
        <legend>
          Цвет <span>{color === 'dark' ? 'Тёмный' : 'Светлый'}</span>
        </legend>
        <div className="catalyst-color-options">
          {(['dark', 'light'] as const).map((value) => (
            <label key={value}>
              <input
                type="radio"
                name="tee-color"
                value={value}
                checked={color === value}
                onChange={() => onColorChange(value)}
              />
              <span>
                <i data-color={value} />
                {value === 'dark' ? 'Тёмный' : 'Светлый'}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset disabled={disabled}>
        <legend>
          Размер <span>Выберите свой</span>
        </legend>
        <div className="catalyst-size-options">
          {['S', 'M', 'L', 'XL'].map((value) => (
            <label key={value}>
              <input
                type="radio"
                name="tee-size"
                value={value}
                checked={size === value}
                onChange={() => onSizeChange(value)}
              />
              <span>{value}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="catalyst-selection">
        <span>Ваш вариант</span>
        <strong>
          {color === 'dark' ? 'Тёмный' : 'Светлый'} · {size}
        </strong>
      </div>
    </div>
  );
}
