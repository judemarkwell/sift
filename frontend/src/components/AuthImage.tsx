import { useEffect, useState, type ImgHTMLAttributes } from 'react'

import { api } from '@/lib/api'

/**
 * An uploaded image. Fetched with the sign-in header (a plain <img src> can't
 * send one) and shown from a local object URL. With `link`, clicking opens
 * the full image in a new tab.
 */
export function AuthImage({ id, link, ...img }: { id: string; link?: boolean } & ImgHTMLAttributes<HTMLImageElement>) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    let made: string | null = null
    api
      .uploadBlob(id)
      .then((blob) => {
        if (!alive) return
        made = URL.createObjectURL(blob)
        setUrl(made)
      })
      .catch(() => alive && setUrl(null))
    return () => {
      alive = false
      if (made) URL.revokeObjectURL(made)
    }
  }, [id])
  const picture = url ? <img src={url} {...img} /> : <span className={img.className} aria-busy="true" />
  return link && url ? (
    <a href={url} target="_blank" rel="noreferrer" className="block">
      {picture}
    </a>
  ) : (
    picture
  )
}
