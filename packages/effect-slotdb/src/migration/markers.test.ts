import { describe, it } from '@effect/vitest'
import * as Schema from 'effect/Schema'
import {
  type IsKeyed,
  type IsUnique,
  type IsImmutable,
  type IsDefaulted,
  type IsLocal,
  type IsFramework,
  type IsTombstone,
  key,
  unique,
  immutable,
  withDefault,
  local,
  createdAt,
  deletedAt,
} from './fields.ts'

/**
 * Checks phantom field markers through compile time assignments. Markers identify field
 * roles without storing annotation values.
 */

const KeyedField = key(1)(Schema.String)
const UniqueField = unique(1)(Schema.String)
const ImmutableField = immutable(Schema.String)
const DefaultedField = withDefault('x')(Schema.String)
const LocalField = local(Schema.String)
const TombstoneField = deletedAt.deletedAt
const CreatedField = createdAt.createdAt

describe('phantom markers', () => {
  it('key sets the key and immutability markers', () => {
    const _isKeyed: true = {} as IsKeyed<typeof KeyedField>
    const _isImmutable: true = {} as IsImmutable<typeof KeyedField>
    const _isNotUnique: false = {} as IsUnique<typeof KeyedField>
  })

  it('unique sets the unique marker only, so the field stays renameable', () => {
    const _isUnique: true = {} as IsUnique<typeof UniqueField>
    const _isNotKeyed: false = {} as IsKeyed<typeof UniqueField>
    const _isNotImmutable: false = {} as IsImmutable<typeof UniqueField>
  })

  it('identity sets the immutability marker only', () => {
    const _isImmutable: true = {} as IsImmutable<typeof ImmutableField>
    const _isNotKeyed: false = {} as IsKeyed<typeof ImmutableField>
  })

  it('withDefault sets the defaulted marker only', () => {
    const _isDefaulted: true = {} as IsDefaulted<typeof DefaultedField>
    const _isNotImmutable: false = {} as IsImmutable<typeof DefaultedField>
  })

  it('local sets the local marker only', () => {
    const _isLocal: true = {} as IsLocal<typeof LocalField>
    const _isNotDefaulted: false = {} as IsDefaulted<typeof LocalField>
  })

  it('deletedAt sets both the framework and tombstone markers', () => {
    const _isFramework: true = {} as IsFramework<typeof TombstoneField>
    const _isTombstone: true = {} as IsTombstone<typeof TombstoneField>
  })

  it('createdAt sets the framework marker and remains in the row type', () => {
    const _isFramework: true = {} as IsFramework<typeof CreatedField>
    const _isNotTombstone: false = {} as IsTombstone<typeof CreatedField>
  })

  it('a plain schema has no markers', () => {
    const _isNotKeyed: false = {} as IsKeyed<Schema.String>
    const _isNotUnique: false = {} as IsUnique<Schema.String>
    const _isNotImmutable: false = {} as IsImmutable<Schema.String>
    const _isNotDefaulted: false = {} as IsDefaulted<Schema.String>
    const _isNotLocal: false = {} as IsLocal<Schema.String>
    const _isNotFramework: false = {} as IsFramework<Schema.String>
    const _isNotTombstone: false = {} as IsTombstone<Schema.String>
  })
})
