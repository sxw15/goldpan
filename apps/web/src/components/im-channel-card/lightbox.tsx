'use client';

import Image from 'next/image';
import { useEffect } from 'react';

export function Lightbox({
  src,
  alt,
  onClose,
  closeLabel,
}: {
  src: string;
  alt: string;
  onClose: () => void;
  closeLabel: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <button
        type="button"
        className="gp-setup-lightbox__backdrop"
        aria-label={closeLabel}
        onClick={onClose}
      />
      <div className="gp-setup-lightbox" role="dialog" aria-modal="true" aria-label={alt}>
        <Image
          src={src}
          alt={alt}
          className="gp-setup-lightbox__img"
          width={1600}
          height={1000}
          unoptimized
        />
      </div>
    </>
  );
}
