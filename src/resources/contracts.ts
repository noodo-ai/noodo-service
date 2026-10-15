import { z } from 'zod'
import { ServiceError } from '../contracts.js'

export const MAX_RESOURCE_BYTES = 10 * 1024 * 1024
export const USER_RESOURCE_BYTES = 100 * 1024 * 1024
// Allow the full metadata body even when each character uses a JSON Unicode escape.
export const RESOURCE_METADATA_BODY_LIMIT = 2 * 1024 * 1024
export const topics = [
  'Research',
  'Markets',
  'Trading',
  'Data',
  'Other',
] as const
export const metadataSchema = z.object({
  title: z.string().trim().min(1).max(120),
  summary: z.string().trim().max(500).default(''),
  body: z.string().max(200000).default(''),
  visibility: z.enum(['public', 'private']).default('private'),
  categoryId: z.string().uuid().nullable().default(null),
  topic: z.enum(topics).default('Other'),
})
export type ResourceInput = z.infer<typeof metadataSchema>
export const createResourceSchema = metadataSchema.extend({
  files: z
    .array(
      z.object({
        name: z
          .string()
          .min(1)
          .max(160)
          .refine(
            (name) =>
              !name.includes('/') &&
              !name.includes('\\') &&
              [...name].every(
                (char) =>
                  char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127,
              ),
          ),
        base64: z
          .string()
          .max(Math.ceil(MAX_RESOURCE_BYTES / 3) * 4)
          .refine(
            (value) =>
              value.length % 4 === 0 &&
              !/[^A-Za-z0-9+/=]/.test(value) &&
              Buffer.from(value, 'base64').toString('base64') === value,
          ),
      }),
    )
    .max(5)
    .default([]),
})
export const fileMimes = {
  md: 'text/plain; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  csv: 'text/plain; charset=utf-8',
  json: 'application/json',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
} as const
export type FileFormat = keyof typeof fileMimes
export interface ResourceFile {
  id: string
  name: string
  format: FileFormat
  mime: string
  bytes: number
}
export interface ResourceRow extends ResourceInput {
  id: string
  ownerId: string
  author: string
  bytes: number
  createdAt: number
  updatedAt: number
}
export function decodeFile(file: {
  name: string
  base64: string
}): Omit<ResourceFile, 'id'> & { content: Buffer } {
  const format = file.name.split('.').at(-1)?.toLowerCase()
  if (!format || !Object.hasOwn(fileMimes, format))
    throw new ServiceError(
      'unsupportedFormat',
      'Use Markdown, TXT, CSV, JSON, PDF, PNG, JPG or WebP',
    )
  const content = Buffer.from(file.base64, 'base64')
  if (!content.length || content.length > MAX_RESOURCE_BYTES)
    throw new ServiceError(
      'fileTooLarge',
      'Files must be nonempty and at most 10 MB',
    )
  let valid: boolean
  if (format === 'pdf') valid = content.subarray(0, 5).toString() === '%PDF-'
  else if (format === 'png')
    valid = content
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  else if (format === 'jpg' || format === 'jpeg')
    valid = content[0] === 255 && content[1] === 216 && content[2] === 255
  else if (format === 'webp')
    valid =
      content.subarray(0, 4).toString() === 'RIFF' &&
      content.subarray(8, 12).toString() === 'WEBP'
  else {
    try {
      const value = new TextDecoder('utf-8', { fatal: true }).decode(content)
      valid = !value.includes('\0')
      if (format === 'json') JSON.parse(value)
    } catch {
      valid = false
    }
  }
  if (!valid)
    throw new ServiceError(
      'invalidFile',
      'File contents do not match the selected format',
    )
  return {
    name: file.name,
    format: format as FileFormat,
    mime: fileMimes[format as FileFormat],
    bytes: content.length,
    content,
  }
}
