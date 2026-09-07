'use client';

import { useState } from 'react';
import { catalystMerch, catalystMerchKind, type CatalystMerchKind } from '../lib/catalyst-merch';

export function CatalystCatalogIntro() {
  return (
    <>
      <div className="merch-intro" aria-hidden="true">
        <span>CATALYST / COLLECTION 2026</span>
        <span>ИДЕИ В ДЕЛО ↗</span>
      </div>
      <aside className="merch-scarcity" aria-label="Условия заказа мерча">
        <span className="merch-scarcity__mark" aria-hidden="true">
          !
        </span>
        <div>
          <strong>Небольшой тираж. Большие планы.</strong>
          <p>
            Блокнотов и шопперов — всего по 50 на весь акселератор. Заявки принимаются в порядке
            живой очереди. Выбирай любимое сейчас: к последнему дню мерч может закончиться.
          </p>
        </div>
      </aside>
    </>
  );
}

export function CatalystProductArt({
  kind,
  title,
  imageUrl,
  detail = false,
}: {
  kind: CatalystMerchKind;
  title: string;
  imageUrl?: string;
  detail?: boolean;
}) {
  const design = catalystMerch[kind];
  return (
    <div className={`merch-art merch-art--${kind}${detail ? ' merch-art--detail' : ''}`}>
      <div className="merch-art__top">
        <span>{design.eyebrow}</span>
        <span>CATALYST ↗</span>
      </div>
      {kind === 'ticket' ? (
        <div className="merch-ticket">
          <span className="merch-ticket__number" aria-hidden="true">
            03
          </span>
          <strong>
            СТАРТАП
            <br />
            ЛИНЧ<span>ВНЕ КОНКУРСА</span>
          </strong>
          <div className="merch-ticket__stub">
            <span>TEAM PASS</span>
            <i aria-hidden="true" />
            <small>ОДИН БИЛЕТ — ОДНА КОМАНДА</small>
          </div>
        </div>
      ) : (
        <div className="merch-art__photo">
          <img
            src={imageUrl ?? `/merch/${design.images[0]}`}
            alt={title}
            width={1200}
            height={1200}
            loading={detail ? 'eager' : 'lazy'}
            decoding="async"
          />
          {kind === 'writing' && !detail ? (
            <img
              className="merch-art__pencil"
              src="/merch/pencil-catalog-v1.webp"
              alt="Карандаш Catalyst"
              width={1200}
              height={1200}
              loading="lazy"
              decoding="async"
            />
          ) : null}
        </div>
      )}
      <div className="merch-art__bottom">
        <strong>{design.line}</strong>
        <span>{design.label}</span>
      </div>
      {kind === 'stickers' ? (
        <span className="merch-art__spark" aria-hidden="true">
          ✳
        </span>
      ) : null}
      {kind === 'cardholder' ? (
        <span className="merch-art__access" aria-hidden="true">
          ● ACCESS GRANTED
        </span>
      ) : null}
    </div>
  );
}

export function CatalystWritingOptions({
  value,
  onChange,
  disabled,
}: {
  value: 'pen' | 'pencil';
  onChange: (value: 'pen' | 'pencil') => void;
  disabled: boolean;
}) {
  return (
    <fieldset className="merch-writing-options" disabled={disabled}>
      <legend>Выбери свой инструмент</legend>
      {(['pen', 'pencil'] as const).map((item) => (
        <label key={item}>
          <input
            type="radio"
            name="writing-kind"
            checked={value === item}
            onChange={() => onChange(item)}
          />
          <span>{item === 'pen' ? 'Ручка' : 'Карандаш'}</span>
        </label>
      ))}
      <p>Цена за один предмет. Выбранный вариант будет указан в заявке.</p>
    </fieldset>
  );
}

export function isCatalystTee(product: { slug?: string; title: string }): boolean {
  return catalystMerchKind(product) === 'tee';
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
