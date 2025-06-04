import {
  IdlInstruction,
  IdlInstructionArg,
  SOLANA_WEB3_EXPORT_NAME,
  IdlInstructionAccount,
  SOLANA_SPL_TOKEN_PACKAGE,
  SOLANA_SPL_TOKEN_EXPORT_NAME,
  TypeMappedSerdeField,
  SOLANA_WEB3_PACKAGE,
  isIdlInstructionAccountWithDesc,
  PrimitiveTypeKey,
  isAccountsCollection,
} from './types'
import { ForceFixable, TypeMapper } from './type-mapper'
import { renderDataStruct } from './serdes'
import {
  isKnownPubkey,
  renderKnownPubkeyAccess,
  ResolvedKnownPubkey,
  resolveKnownPubkey,
} from './known-pubkeys'
import { BEET_PACKAGE } from '@metaplex-foundation/beet'
import { renderScalarEnums } from './render-enums'
import { InstructionDiscriminator } from './instruction-discriminator'
import { PathLike } from 'fs'

type ProcessedAccountKey = IdlInstructionAccount & {
  knownPubkey?: ResolvedKnownPubkey
  optional: boolean
}

class InstructionRenderer {
  readonly pascalIxName: string
  readonly camelIxName: string
  readonly argsTypename: string
  readonly accountsTypename: string
  readonly instructionDiscriminatorName: string
  readonly structArgName: string
  private readonly defaultOptionalAccounts: boolean
  private readonly instructionDiscriminator: InstructionDiscriminator
  private readonly programIdPubkey: string

  constructor(
    readonly ix: IdlInstruction,
    readonly fullFileDir: PathLike,
    readonly programId: string,
    private readonly typeMapper: TypeMapper,
    private readonly renderAnchorRemainingAccounts: boolean
  ) {
    this.pascalIxName = this.toPascalCase(ix.name)
    this.camelIxName =
      this.pascalIxName.charAt(0).toLowerCase() + this.pascalIxName.slice(1)
    this.argsTypename = `${this.pascalIxName}InstructionArgs`
    this.accountsTypename = `${this.pascalIxName}InstructionAccounts`
    this.instructionDiscriminatorName = `${this.camelIxName}InstructionDiscriminator`
    this.structArgName = `${ix.name}Struct`

    this.instructionDiscriminator = new InstructionDiscriminator(
      ix,
      'instructionDiscriminator',
      typeMapper
    )
    this.programIdPubkey = `new ${SOLANA_WEB3_EXPORT_NAME}.PublicKey('${this.programId}')`
    this.defaultOptionalAccounts = !ix.legacyOptionalAccountsStrategy
  }

  // -----------------
  // Instruction Args Type
  // -----------------
  private renderIxArgField = (arg: IdlInstructionArg) => {
    const typescriptType = this.typeMapper.map(arg.type, arg.name)
    return `${InstructionRenderer.toCamelCase(arg.name)}: ${typescriptType}`
  }

  private renderIxArgsType(argsTypename: string) {
    if (this.ix.args.length === 0) return ''
    const fields = this.ix.args
      .map((field) => this.renderIxArgField(field))
      .join(',\n  ')

    const code = `
/**
 * @category Instructions
 * @category generated
 */
export type ${argsTypename} = {
  ${fields}
}`.trim()
    return code
  }

  // -----------------
  // Imports
  // -----------------
  private renderImports(processedKeys: ProcessedAccountKey[]) {
    const typeMapperImports = this.typeMapper.importsUsed(
      this.fullFileDir.toString(),
      new Set([SOLANA_WEB3_PACKAGE, BEET_PACKAGE])
    )
    const needsSplToken = processedKeys.some(
      (x) => x.knownPubkey?.pack === SOLANA_SPL_TOKEN_PACKAGE
    )
    const splToken = needsSplToken
      ? `\nimport * as ${SOLANA_SPL_TOKEN_EXPORT_NAME} from '${SOLANA_SPL_TOKEN_PACKAGE}';`
      : ''

    return `
${splToken}
${typeMapperImports.join('\n')}`.trim()
  }

  // -----------------
  // Accounts
  // -----------------
  private processIxAccounts(): ProcessedAccountKey[] {
    let processedAccountsKey: ProcessedAccountKey[] = []
    for (const acc of this.ix.accounts) {
      if (isAccountsCollection(acc)) {
        for (const ac of acc.accounts) {
          // Make collection items easy to identify and avoid name clashes
          ac.name = deriveCollectionAccountsName(ac.name, acc.name)
          const knownPubkey = resolveKnownPubkey(ac.name)
          const optional = ac.optional ?? ac.isOptional ?? false
          if (knownPubkey == null) {
            processedAccountsKey.push({ ...ac, optional })
          } else {
            processedAccountsKey.push({ ...ac, knownPubkey, optional })
          }
        }
      } else {
        const knownPubkey = resolveKnownPubkey(acc.name)
        const optional = acc.optional ?? acc.isOptional ?? false
        if (knownPubkey == null) {
          processedAccountsKey.push({ ...acc, optional })
        } else {
          processedAccountsKey.push({ ...acc, knownPubkey, optional })
        }
      }
    }
    return processedAccountsKey
  }

  // -----------------
  // AccountKeys
  // -----------------

  /*
   * Main entry to render account metadata for provided account keys.
   * The `defaultOptionalAccounts` strategy determines how optional accounts
   * are rendered.
   *
   * a) If the defaultOptionalAccounts strategy is set all accounts will be
   *    added to the accounts array, but default to the program id when they weren't
   *    provided by the user.
   *
   * b) If the defaultOptionalAccounts strategy is not enabled optional accounts
   *    that are not provided will be omitted from the accounts array.
   *
   * @private
   */
  private renderIxAccountKeys(processedKeys: ProcessedAccountKey[]) {
    const fixedAccountKeys = this.defaultOptionalAccounts
      ? this.renderAccountKeysDefaultingOptionals(processedKeys)
      : this.renderAccountKeysNotDefaultingOptionals(processedKeys)

    const anchorRemainingAccounts =
      this.renderAnchorRemainingAccounts && processedKeys.length > 0
        ? `
  if (accounts.anchorRemainingAccounts != null) {
    for (const acc of accounts.anchorRemainingAccounts) {
      keys.push(acc)
    }
  }
`
        : ''

    return `${fixedAccountKeys}\n${anchorRemainingAccounts}\n`
  }

  // -----------------
  // AccountKeys: with strategy to not defaultOptionalAccounts
  // -----------------
  private renderAccountKeysNotDefaultingOptionals(
    processedKeys: ProcessedAccountKey[]
  ) {
    const indexOfFirstOptional = processedKeys.findIndex((x) => x.optional)
    if (indexOfFirstOptional === -1) {
      return this.renderAccountKeysInsideArray(processedKeys) + '\n'
    }

    const accountsInsideArray = this.renderAccountKeysInsideArray(
      processedKeys.slice(0, indexOfFirstOptional)
    )
    const accountsToPush = this.renderAccountKeysToPush(
      processedKeys.slice(indexOfFirstOptional)
    )

    return `${accountsInsideArray}\n${accountsToPush}`
  }

  private renderAccountKeysInsideArray(processedKeys: ProcessedAccountKey[]) {
    const metaElements = processedKeys
      .map((processedKey) =>
        renderRequiredAccountMeta(processedKey, this.programIdPubkey)
      )
      .join(',\n    ')
    return `[\n    ${metaElements}\n  ]`
  }

  private renderAccountKeysToPush(processedKeys: ProcessedAccountKey[]) {
    if (processedKeys.length === 0) {
      return ''
    }

    const statements = processedKeys
      .map((processedKey, idx) => {
        const camelName = InstructionRenderer.toCamelCase(processedKey.name)
        if (!processedKey.optional) {
          const accountMeta = renderRequiredAccountMeta(
            processedKey,
            this.programIdPubkey
          )
          return `keys.push(${accountMeta})`
        }

        const requiredOptionals = processedKeys
          .slice(0, idx)
          .filter((x) => x.optional)
        const requiredChecks = requiredOptionals
          .map((x) => `accounts.${InstructionRenderer.toCamelCase(x.name)} == null`)
          .join(' || ')
        const checkRequireds =
          requiredChecks.length > 0
            ? `if (${requiredChecks}) { throw new Error('When providing \'${camelName}\' then ` +
              `${requiredOptionals
                .map((x) => `\'accounts.${InstructionRenderer.toCamelCase(x.name)}\'`)
                .join(', ')} need(s) to be provided as well.') }`
            : ''
        const pubkey = `accounts.${camelName}`
        const accountMeta = renderAccountMeta(
          pubkey,
          processedKey.isMut.toString(),
          processedKey.isSigner.toString()
        )

        // renderRequiredAccountMeta
        // NOTE: we purposely don't add the default resolution here since the intent is to
        // only pass that account when it is provided
        return `
if (accounts.${camelName} != null) {
  ${checkRequireds}
  keys.push(${accountMeta})
}`.trim()
      })
      .join('\n')

    return `\n${statements}\n`
  }

  // -----------------
  // AccountKeys: with strategy to defaultOptionalAccounts
  // -----------------

  /*
   * This renders optional accounts when the defaultOptionalAccounts strategy is
   * enabled.
   * This means that all accounts will be added to the accounts array, but default
   * to the program id when they weren't provided by the user.
   * @category private
   */
  private renderAccountKeysDefaultingOptionals(
    processedKeys: ProcessedAccountKey[]
  ) {
    const metaElements = processedKeys
      .map((processedKey) => {
        return processedKey.optional
          ? renderOptionalAccountMetaDefaultingToProgramId(processedKey)
          : renderRequiredAccountMeta(processedKey, this.programIdPubkey)
      })
      .join(',\n    ')
    return `[\n    ${metaElements}\n  ]`
  }

  // -----------------
  // AccountsType
  // -----------------

  private renderAccountsType(processedKeys: ProcessedAccountKey[], accountsTypename: string) {
    if (processedKeys.length === 0) return ''
    const web3 = SOLANA_WEB3_EXPORT_NAME
    const fields = processedKeys
      .map((x) => {
        const propName = InstructionRenderer.toCamelCase(x.name)
        if (x.knownPubkey != null) {
          return `${propName}?: ${web3}.PublicKey`
        }
        const optional = x.optional ? '?' : ''
        return `${propName}${optional}: ${web3}.PublicKey`
      })
      .join('\n  ')

    const anchorRemainingAccounts = this.renderAnchorRemainingAccounts
      ? 'anchorRemainingAccounts?: web3.AccountMeta[]'
      : ''

    const propertyComments = processedKeys
      // known pubkeys are not provided by the user and thus aren't part of the type
      .filter((x) => !isKnownPubkey(x.name))
      .map((x) => {
        const attrs = []
        if (x.isMut) attrs.push('_writable_')
        if (x.isSigner) attrs.push('**signer**')

        const optional = x.optional ? ' (optional) ' : ' '
        const desc = isIdlInstructionAccountWithDesc(x) ? x.desc : ''
        // Use camelCase in the property comment as well
        return (
          `* @property [${attrs.join(', ')}] ` + `${InstructionRenderer.toCamelCase(x.name)}${optional}${desc} `
        )
      })

    const properties =
      propertyComments.length > 0
        ? `\n *\n  ${propertyComments.join('\n')} `
        : ''

    const docs = `
/**
  * Accounts required by the _${accountsTypename}_ instruction${properties}
  * @category Instructions
  * @category generated
  */
`.trim()
    return `${docs}
export type ${accountsTypename} = {
  ${fields}
  ${anchorRemainingAccounts}
}`
  }

  private renderAccountsParamDoc(processedKeys: ProcessedAccountKey[]) {
    if (processedKeys.length === 0) return '  *'
    return `  *
  * @param accounts that will be accessed while the instruction is processed`
  }

  private renderAccountsArg(processedKeys: ProcessedAccountKey[]) {
    if (processedKeys.length === 0) return ''
    return `accounts: ${this.accountsTypename}, \n`
  }

  // -----------------
  // Data Struct
  // -----------------
  private serdeProcess() {
    return this.typeMapper.mapSerdeFields(this.ix.args)
  }

  private renderDataStruct(args: TypeMappedSerdeField[], argsTypename: string) {
    const discriminatorField = this.typeMapper.mapSerdeField(
      this.instructionDiscriminator.getField()
    )
    const discriminatorType = this.instructionDiscriminator.renderType()
    const camelCasedArgs = args.map(arg => ({ ...arg, name: InstructionRenderer.toCamelCase(arg.name) }))
    const struct = renderDataStruct({
      fields: camelCasedArgs,
      discriminatorName: 'instructionDiscriminator',
      discriminatorField,
      discriminatorType,
      structVarName: this.structArgName,
      argsTypename: argsTypename,
      isFixable: this.typeMapper.usedFixableSerde,
    })
    return `
/**
 * @category Instructions
 * @category generated
 */
${struct} `.trim()
  }

  render() {
    this.typeMapper.clearUsages()

    const pascalIxName = this.pascalIxName
    const argsTypename = `${pascalIxName}InstructionArgs`
    const accountsTypename = `${pascalIxName}InstructionAccounts`
    const instructionDiscriminatorName = `${pascalIxName.charAt(0).toLowerCase()}${pascalIxName.slice(1)}InstructionDiscriminator`
    const structArgName = `${this.ix.name}Struct`

    const ixArgType = this.renderIxArgsType(argsTypename)
    const processedKeys = this.processIxAccounts()
    const accountsType = this.renderAccountsType(processedKeys, accountsTypename)

    const processedArgs = this.serdeProcess()
    const argsStructType = this.renderDataStruct(processedArgs, argsTypename)

    const keys = this.renderIxAccountKeys(processedKeys)
    const accountsParamDoc = this.renderAccountsParamDoc(processedKeys)
    const accountsArg = this.renderAccountsArg(processedKeys)
    const instructionDisc = this.instructionDiscriminator.renderValue()
    const enums = renderScalarEnums(this.typeMapper.scalarEnumsUsed).join('\n')

    const web3 = SOLANA_WEB3_EXPORT_NAME
    const imports = this.renderImports(processedKeys)

    const [
      createInstructionArgsComment,
      createInstructionArgs,
      createInstructionArgsSpread,
      comma,
    ] =
      this.ix.args.length === 0
        ? ['', '', '', '']
        : [
            `\n * @param args to provide as instruction data to the program\n * `,
            `args: ${argsTypename} `,
            '...args',
            ', ',
          ]
    const programIdArg = `${comma}programId = ${this.programIdPubkey}`

    const optionalAccountsComment = optionalAccountsStrategyDocComment(
      this.defaultOptionalAccounts,
      processedKeys.some((x) => x.optional)
    )
    const functionName = `create${pascalIxName}Instruction`
    return `${imports}

${enums}
${ixArgType}
${argsStructType}
${accountsType}
    export const ${instructionDiscriminatorName} = ${instructionDisc};

    /**
     * Creates a _${pascalIxName}_ instruction.
    ${optionalAccountsComment}${accountsParamDoc}${createInstructionArgsComment}
     * @category Instructions
     * @category ${pascalIxName}
     * @category generated
     */
    export function ${functionName}(
      ${accountsArg}${createInstructionArgs}${programIdArg}
    ) {
      const [data] = ${structArgName}.serialize({
        instructionDiscriminator: ${instructionDiscriminatorName},
    ${createInstructionArgsSpread}
    });
    const keys: ${web3}.AccountMeta[] = ${keys}
    const ix = new ${web3}.TransactionInstruction({
      programId,
      keys,
      data
  });
  return ix; 
}
`
  }

  // Utility to convert snake_case to PascalCase (UpperCamelCase), removing leading 'create_'
  private toPascalCase(s: string) {
    return s
      .replace(/^create_/, '') // Remove leading create_
      .replace(/(^|_)([a-z])/g, (_, __, c) => c.toUpperCase());
  }

  static toCamelCase(s: string) {
    return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  }
}

export function renderInstruction(
  ix: IdlInstruction,
  fullFileDir: PathLike,
  programId: string,
  accountFilesByType: Map<string, string>,
  customFilesByType: Map<string, string>,
  typeAliases: Map<string, PrimitiveTypeKey>,
  forceFixable: ForceFixable,
  renderAnchorRemainingAccounts: boolean
) {
  const typeMapper = new TypeMapper(
    accountFilesByType,
    customFilesByType,
    typeAliases,
    forceFixable
  )
  const renderer = new InstructionRenderer(
    ix,
    fullFileDir,
    programId,
    typeMapper,
    renderAnchorRemainingAccounts
  )
  return renderer.render()
}

// -----------------
// Utility Functions
// -----------------

function renderAccountMeta(
  pubkey: string,
  isWritable: string,
  isSigner: string
): string {
  return `{
      pubkey: ${pubkey},
      isWritable: ${isWritable},
      isSigner: ${isSigner},
    }`
}

function deriveCollectionAccountsName(
  accountName: string,
  collectionName: string
) {
  const camelAccount = accountName
    .charAt(0)
    .toUpperCase()
    .concat(accountName.slice(1))

  return `${collectionName}Item${camelAccount}`
}

function renderOptionalAccountMetaDefaultingToProgramId(
  processedKey: ProcessedAccountKey
): string {
  const { name, isMut = false, isSigner = false } = processedKey
  const camelName = InstructionRenderer.toCamelCase(name)
  const pubkey = `accounts.${camelName} ?? programId`
  const mut = isMut ? `accounts.${camelName} != null` : 'false'
  const signer = isSigner ? `accounts.${camelName} != null` : 'false'
  return renderAccountMeta(pubkey, mut, signer)
}

function renderRequiredAccountMeta(
  processedKey: ProcessedAccountKey,
  programIdPubkey: string
): string {
  const { name, isMut = false, isSigner = false, knownPubkey } = processedKey
  const camelName = InstructionRenderer.toCamelCase(name)
  const pubkey =
    knownPubkey == null
      ? `accounts.${camelName}`
      : `accounts.${camelName} ?? ${renderKnownPubkeyAccess(
          knownPubkey,
          programIdPubkey
        )}`
  return renderAccountMeta(pubkey, isMut.toString(), isSigner.toString())
}

function optionalAccountsStrategyDocComment(
  defaultOptionalAccounts: boolean,
  someAccountIsOptional: boolean
) {
  if (!someAccountIsOptional) return ''

  if (defaultOptionalAccounts) {
    return ` * 
 * Optional accounts that are not provided default to the program ID since 
 * this was indicated in the IDL from which this instruction was generated.
`
  }
  return ` * 
 * Optional accounts that are not provided will be omitted from the accounts
 * array passed with the instruction.
 * An optional account that is set cannot follow an optional account that is unset.
 * Otherwise an Error is raised.
`
}
