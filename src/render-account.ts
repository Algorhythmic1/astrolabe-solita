import { PathLike } from 'fs'
import { renderScalarEnums } from './render-enums'
import { renderDataStruct } from './serdes'
import { CustomSerializers, SerializerSnippets } from './serializers'
import { ForceFixable, TypeMapper } from './type-mapper'
import { strict as assert } from 'assert'
import {
  asIdlTypeArray,
  BEET_PACKAGE,
  BEET_SOLANA_EXPORT_NAME,
  BEET_SOLANA_PACKAGE,
  hasPaddingAttr,
  IdlAccount,
  PrimitiveTypeKey,
  SOLANA_WEB3_EXPORT_NAME,
  SOLANA_WEB3_PACKAGE,
  TypeMappedSerdeField,
} from './types'
import {
  accountDiscriminator,
  anchorDiscriminatorField,
  anchorDiscriminatorType,
} from './utils'

function colonSeparatedTypedField(
  field: { name: string; tsType: string },
  prefix = ''
) {
  return `${prefix}${field.name}: ${field.tsType}`
}

class AccountRenderer {
  readonly upperCamelAccountName: string
  readonly camelAccountName: string
  readonly accountDataClassName: string
  readonly accountDataArgsTypeName: string
  readonly accountDiscriminatorName: string
  readonly beetName: string
  readonly paddingField?: { name: string; size: number }

  readonly serializerSnippets: SerializerSnippets
  private readonly programIdPubkey: string

  constructor(
    private readonly account: IdlAccount,
    private readonly fullFileDir: PathLike,
    private readonly hasImplicitDiscriminator: boolean,
    private readonly programId: string,
    private readonly typeMapper: TypeMapper,
    private readonly serializers: CustomSerializers
  ) {
    this.upperCamelAccountName = account.name
      .charAt(0)
      .toUpperCase()
      .concat(account.name.slice(1))

    this.camelAccountName = account.name
      .charAt(0)
      .toLowerCase()
      .concat(account.name.slice(1))

    this.accountDataClassName = this.upperCamelAccountName
    this.accountDataArgsTypeName = `${this.accountDataClassName}Args`
    this.beetName = `${this.camelAccountName}Beet`
    this.accountDiscriminatorName = `${this.camelAccountName}Discriminator`

    this.serializerSnippets = this.serializers.snippetsFor(
      this.account.name,
      this.fullFileDir as string,
      this.beetName
    )
    this.paddingField = this.getPaddingField()

    this.programIdPubkey = `new ${SOLANA_WEB3_EXPORT_NAME}.PublicKey('${this.programId}')`
  }

  private getPaddingField() {
    if (!this.account.type || !Array.isArray(this.account.type.fields)) {
      console.error('Malformed account:', this.account);
      throw new Error(
        `Account ${this.account.name} is missing a type or fields array in the IDL.`
      );
    }
    const paddingField = this.account.type.fields.filter((f) =>
      hasPaddingAttr(f)
    )
    if (paddingField.length === 0) return

    assert.equal(
      paddingField.length,
      1,
      'only one field of an account can be padding'
    )
    const field = paddingField[0]
    const ty = asIdlTypeArray(field.type)
    const [inner, size] = ty.array
    assert.equal(inner, 'u8', 'padding field must be u8[]')
    return { name: field.name, size }
  }

  private serdeProcess() {
    return this.typeMapper.mapSerdeFields(this.account.type.fields)
  }

  // Utility to convert snake_case to camelCase
  private toCamelCase(s: string) {
    return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  }

  // -----------------
  // Rendered Fields
  // -----------------
  private getTypedFields() {
    return this.account.type.fields.map((field) => {
      const tsType = this.typeMapper.map(field.type, field.name)
      return {
        name: this.toCamelCase(field.name),
        tsType: tsType ?? 'any',
        isPadding: hasPaddingAttr(field),
      }
    })
  }

  private getPrettyFields() {
    return this.getTypedFields().map((f) => `${f.name}: this.${f.name}`).filter(Boolean)
  }

  // -----------------
  // Imports
  // -----------------
  private renderImports() {
    const imports = this.typeMapper.importsUsed(
      this.fullFileDir.toString(),
      new Set([SOLANA_WEB3_PACKAGE, BEET_PACKAGE, BEET_SOLANA_PACKAGE])
    )
    return imports.join('\n')
  }

  // -----------------
  // Account Args
  // -----------------
  private renderAccountDataArgsType(
    fields: { name: string; tsType: string; isPadding: boolean }[]
  ) {
    const argsFields = fields
      .filter((f) => !f.isPadding)
      .map((f) => `${f.name}: ${f.tsType}`)
      .join(',\n  ')
    return `export type ${this.accountDataArgsTypeName} = {\n  ${argsFields}\n}`
  }

  private renderByteSizeMethods() {
    if (this.typeMapper.usedFixableSerde) {
      const byteSizeValue = this.hasImplicitDiscriminator
        ? `{
      accountDiscriminator: ${this.accountDiscriminatorName},
      ...instance,
    }`
        : `instance`

      return `
  /**
   * Returns the byteSize of a {@link Buffer} holding the serialized data of
   * {@link ${this.accountDataClassName}} for the provided args.
   *
   * @param args need to be provided since the byte size for this account
   * depends on them
   */
  static byteSize(args: ${this.accountDataArgsTypeName}) {
    const instance = ${this.accountDataClassName}.fromArgs(args)
    return ${this.beetName}.toFixedFromValue(${byteSizeValue}).byteSize
  }

  /**
   * Fetches the minimum balance needed to exempt an account holding 
   * {@link ${this.accountDataClassName}} data from rent
   *
   * @param args need to be provided since the byte size for this account
   * depends on them
   * @param connection used to retrieve the rent exemption information
   */
  static async getMinimumBalanceForRentExemption(
    args: ${this.accountDataArgsTypeName},
    connection: web3.Connection,
    commitment?: web3.Commitment
  ): Promise<number> {
    return connection.getMinimumBalanceForRentExemption(
      ${this.accountDataClassName}.byteSize(args),
      commitment
    )
  }
  `.trim()
    } else {
      return `
  /**
   * Returns the byteSize of a {@link Buffer} holding the serialized data of
   * {@link ${this.accountDataClassName}}
   */
  static get byteSize() {
    return ${this.beetName}.byteSize;
  }

  /**
   * Fetches the minimum balance needed to exempt an account holding 
   * {@link ${this.accountDataClassName}} data from rent
   *
   * @param connection used to retrieve the rent exemption information
   */
  static async getMinimumBalanceForRentExemption(
    connection: web3.Connection,
    commitment?: web3.Commitment,
  ): Promise<number> {
    return connection.getMinimumBalanceForRentExemption(
      ${this.accountDataClassName}.byteSize,
      commitment,
    );
  }

  /**
   * Determines if the provided {@link Buffer} has the correct byte size to
   * hold {@link ${this.accountDataClassName}} data.
   */
  static hasCorrectByteSize(buf: Buffer, offset = 0) {
    return buf.byteLength - offset === ${this.accountDataClassName}.byteSize;
  }
      `.trim()
    }
  }

  // -----------------
  // AccountData class
  // -----------------
  private renderAccountDiscriminatorVar() {
    if (!this.hasImplicitDiscriminator) return ''

    const accountDisc = JSON.stringify(
      Array.from(accountDiscriminator(this.account.name))
    )

    return `export const ${this.accountDiscriminatorName} = ${accountDisc}`
  }

  private renderSerializeValue() {
    const serializeValues = []
    if (this.hasImplicitDiscriminator) {
      serializeValues.push(
        `accountDiscriminator: ${this.accountDiscriminatorName}`
      )
    }
    if (this.paddingField != null) {
      serializeValues.push(`padding: Array(${this.paddingField.size}).fill(0)`)
    }
    return serializeValues.length > 0
      ? `{ 
      ${serializeValues.join(',\n      ')},
      ...this
    }`
      : 'this'
  }

  private renderAccountDataClass(
    fields: { name: string; tsType: string; isPadding: boolean }[]
  ) {
    const constructorArgs = fields
      .filter((f) => !f.isPadding)
      .map((f) => colonSeparatedTypedField(f, 'readonly '))
      .join(',\n    ')

    const constructorParams = fields
      .filter((f) => !f.isPadding)
      .map((f) => `args.${f.name}`)
      .join(',\n      ')

    const prettyFields = this.getPrettyFields().join(',\n      ')
    const byteSizeMethods = this.renderByteSizeMethods()
    const accountDiscriminatorVar = this.renderAccountDiscriminatorVar()
    const serializeValue = this.renderSerializeValue()

    return `
${accountDiscriminatorVar};
/**
 * Holds the data for the {@link ${this.upperCamelAccountName}} Account and provides de/serialization
 * functionality for that data
 *
 * @category Accounts
 * @category generated
 */
export class ${this.accountDataClassName} implements ${this.accountDataArgsTypeName} {
  private constructor(
    ${constructorArgs}
  ) {}

  /**
   * Creates a {@link ${this.accountDataClassName}} instance from the provided args.
   */
  static fromArgs(args: ${this.accountDataArgsTypeName}) {
    return new ${this.accountDataClassName}(
      ${constructorParams}
    );
  }

  /**
   * Deserializes the {@link ${this.accountDataClassName}} from the data of the provided {@link web3.AccountInfo}.
   * @returns a tuple of the account data and the offset up to which the buffer was read to obtain it.
   */
  static fromAccountInfo(
    accountInfo: web3.AccountInfo<Buffer>,
    offset = 0
  ): [ ${this.accountDataClassName}, number ]  {
    return ${this.accountDataClassName}.deserialize(accountInfo.data, offset)
  }

  /**
   * Retrieves the account info from the provided address and deserializes
   * the {@link ${this.accountDataClassName}} from its data.
   *
   * @throws Error if no account info is found at the address or if deserialization fails
   */
  static async fromAccountAddress(
    connection: web3.Connection,
    address: web3.PublicKey,
    commitmentOrConfig?: web3.Commitment | web3.GetAccountInfoConfig,
  ): Promise<${this.accountDataClassName}> {
    const accountInfo = await connection.getAccountInfo(address, commitmentOrConfig);
    if (accountInfo == null) {
      throw new Error(\`Unable to find ${this.accountDataClassName} account at \${address}\`);
    }
    return ${this.accountDataClassName}.fromAccountInfo(accountInfo, 0)[0];
  }


  /**
   * Provides a {@link ${SOLANA_WEB3_EXPORT_NAME}.Connection.getProgramAccounts} config builder,
   * to fetch accounts matching filters that can be specified via that builder.
   *
   * @param programId - the program that owns the accounts we are filtering
   */
  static gpaBuilder(programId: web3.PublicKey = ${this.programIdPubkey}) {
    return ${BEET_SOLANA_EXPORT_NAME}.GpaBuilder.fromStruct(programId, ${this.beetName})
  }

  /**
   * Deserializes the {@link ${this.accountDataClassName}} from the provided data Buffer.
   * @returns a tuple of the account data and the offset up to which the buffer was read to obtain it.
   */
  static deserialize(
    buf: Buffer,
    offset = 0
  ): [ ${this.accountDataClassName}, number ]{
    return ${this.serializerSnippets.deserialize}(buf, offset);
  }

  /**
   * Serializes the {@link ${this.accountDataClassName}} into a Buffer.
   * @returns a tuple of the created Buffer and the offset up to which the buffer was written to store it.
   */
  serialize(): [ Buffer, number ] {
    return ${this.serializerSnippets.serialize}(${serializeValue})
  }

  ${byteSizeMethods}

  /**
   * Returns a readable version of {@link ${this.accountDataClassName}} properties
   * and can be used to convert to JSON and/or logging
   */
  pretty() {
    return {
      ${prettyFields}
    };
  }
}`.trim()
  }

  // -----------------
  // Struct
  // -----------------
  private renderBeet(fields: TypeMappedSerdeField[]) {
    let discriminatorName: string | undefined
    let discriminatorField: TypeMappedSerdeField | undefined
    let discriminatorType: string | undefined

    if (this.hasImplicitDiscriminator) {
      discriminatorName = 'accountDiscriminator'
      discriminatorField = this.typeMapper.mapSerdeField(
        anchorDiscriminatorField('accountDiscriminator')
      )
      discriminatorType = anchorDiscriminatorType(
        this.typeMapper,
        `account ${this.account.name} discriminant type`
      )
    }

    const struct = renderDataStruct({
      fields,
      structVarName: this.beetName,
      className: this.accountDataClassName,
      argsTypename: this.accountDataArgsTypeName,
      discriminatorName,
      discriminatorField,
      discriminatorType,
      paddingField: this.paddingField,
      isFixable: this.typeMapper.usedFixableSerde,
    })
    return `
/**
 * @category Accounts
 * @category generated
 */
${struct}`.trim()
  }

  render() {
    this.typeMapper.clearUsages()

    const typedFields = this.getTypedFields()
    const beetFields = this.serdeProcess()
    const enums = renderScalarEnums(this.typeMapper.scalarEnumsUsed).join('\n')
    const imports = this.renderImports()
    const accountDataArgsType = this.renderAccountDataArgsType(typedFields)
    const accountDataClass = this.renderAccountDataClass(typedFields)
    const beetDecl = this.renderBeet(beetFields)
    return `${imports}
${this.serializerSnippets.importSnippet}

${enums}

${accountDataArgsType}

${accountDataClass}

${beetDecl}

${this.serializerSnippets.resolveFunctionsSnippet}`
  }
}

export function renderAccount(
  account: IdlAccount,
  fullFileDir: PathLike,
  accountFilesByType: Map<string, string>,
  customFilesByType: Map<string, string>,
  typeAliases: Map<string, PrimitiveTypeKey>,
  serializers: CustomSerializers,
  forceFixable: ForceFixable,
  programId: string,
  hasImplicitDiscriminator: boolean
) {
  const typeMapper = new TypeMapper(
    accountFilesByType,
    customFilesByType,
    typeAliases,
    forceFixable
  )
  const renderer = new AccountRenderer(
    account,
    fullFileDir,
    hasImplicitDiscriminator,
    programId,
    typeMapper,
    serializers
  )
  return renderer.render()
}
