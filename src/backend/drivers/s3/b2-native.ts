import type { S3Addition } from "./types"

export type B2File = {
  fileId: string
  fileName: string
  contentLength: number
  contentSha1?: string
  contentType?: string
  fileInfo?: Record<string, string>
  action?: string
  serverSideEncryption?: { mode?: string }
}

type Authorization = {
  accountId: string
  authorizationToken: string
  apiInfo: {
    storageApi: {
      apiUrl: string
      allowed?: {
        buckets?: { id: string; name: string | null }[]
        capabilities?: string[]
        namePrefix?: string | null
      }
    }
  }
}

/** B2 Native API is only used for B2 mounts; ordinary S3 mounts keep SigV4. */
export class B2NativeClient {
  private authorization?: Authorization
  private bucketId?: string

  constructor(private readonly addition: S3Addition) {
    const endpoint = new URL(
      addition.endpoint.includes("://")
        ? addition.endpoint
        : `https://${addition.endpoint}`,
    )
    if (
      endpoint.protocol !== "https:" ||
      !/^s3\.[a-z0-9-]+\.backblazeb2\.com$/i.test(endpoint.hostname)
    ) {
      throw new Error("B2 Native rename requires a Backblaze B2 S3 endpoint")
    }
  }

  private async authorize(): Promise<Authorization> {
    if (this.authorization) return this.authorization
    const credentials = btoa(
      `${this.addition.access_key_id}:${this.addition.secret_access_key}`,
    )
    const response = await fetch(
      "https://api.backblazeb2.com/b2api/v4/b2_authorize_account",
      { headers: { Authorization: `Basic ${credentials}` } },
    )
    if (!response.ok)
      throw new Error(`B2 authorization failed (${response.status})`)
    const result = (await response.json()) as Authorization
    if (!result.authorizationToken || !result.apiInfo?.storageApi?.apiUrl)
      throw new Error("Invalid B2 authorization response")
    this.authorization = result
    return result
  }

  async ensureRenameCapabilities(): Promise<void> {
    const auth = await this.authorize()
    const capabilities = auth.apiInfo.storageApi.allowed?.capabilities
    if (
      capabilities &&
      !["listFiles", "readFiles", "writeFiles", "deleteFiles"].every(
        (capability) => capabilities.includes(capability),
      )
    )
      throw new Error(
        "B2 application key requires listFiles, readFiles, writeFiles and deleteFiles",
      )
  }

  private async call<T>(operation: string, body: object): Promise<T> {
    let auth = await this.authorize()
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(
        `${auth.apiInfo.storageApi.apiUrl}/b2api/v4/${operation}`,
        {
          method: "POST",
          headers: {
            Authorization: auth.authorizationToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        },
      )
      if (response.status === 401 && attempt === 0) {
        this.authorization = undefined
        auth = await this.authorize()
        continue
      }
      const result = (await response.json()) as any
      if (!response.ok)
        throw new Error(
          `B2 ${operation}: ${result.code || response.status}: ${result.message || "request failed"}`,
        )
      return result as T
    }
    throw new Error(`B2 ${operation}: authentication failed`)
  }

  async getBucketId(): Promise<string> {
    if (this.bucketId) return this.bucketId
    const auth = await this.authorize()
    const permitted = auth.apiInfo.storageApi.allowed?.buckets || []
    const named = permitted.find(
      (bucket) => bucket.name === this.addition.bucket,
    )
    if (named) return (this.bucketId = named.id)
    if (permitted.length === 1 && permitted[0].name === null)
      return (this.bucketId = permitted[0].id)
    const result = await this.call<{
      buckets: { bucketId: string; bucketName: string }[]
    }>("b2_list_buckets", {
      accountId: auth.accountId,
      bucketName: this.addition.bucket,
    })
    const bucket = result.buckets?.find(
      (entry) => entry.bucketName === this.addition.bucket,
    )
    if (!bucket) throw new Error("B2 bucket not found")
    return (this.bucketId = bucket.bucketId)
  }

  async list(
    prefix: string,
    startFileName?: string,
    maxFileCount = 500,
  ): Promise<{
    files: B2File[]
    nextFileName?: string
  }> {
    const result = await this.call<{ files: B2File[]; nextFileName?: string }>(
      "b2_list_file_names",
      {
        bucketId: await this.getBucketId(),
        prefix,
        maxFileCount,
        ...(startFileName ? { startFileName } : {}),
      },
    )
    if (
      !Array.isArray(result.files) ||
      result.files.some(
        (f) =>
          !f.fileName?.startsWith(prefix) ||
          !f.fileId ||
          !Number.isSafeInteger(f.contentLength) ||
          f.contentLength < 0,
      )
    )
      throw new Error("Invalid B2 file listing")
    if (result.nextFileName && result.nextFileName === startFileName)
      throw new Error("Invalid B2 listing cursor")
    return {
      files: result.files,
      nextFileName: result.nextFileName?.startsWith(prefix)
        ? result.nextFileName
        : undefined,
    }
  }

  async exact(fileName: string): Promise<B2File | null> {
    const page = await this.list(fileName, fileName, 1)
    return page.files[0]?.fileName === fileName ? page.files[0] : null
  }

  async fileInfo(fileId: string): Promise<B2File> {
    return this.call<B2File>("b2_get_file_info", { fileId })
  }

  async copy(sourceFileId: string, fileName: string): Promise<B2File> {
    return this.call<B2File>("b2_copy_file", {
      sourceFileId,
      fileName,
      metadataDirective: "COPY",
    })
  }

  async startLarge(source: B2File, fileName: string): Promise<B2File> {
    return this.call<B2File>("b2_start_large_file", {
      bucketId: await this.getBucketId(),
      fileName,
      contentType: source.contentType || "b2/x-auto",
      fileInfo: source.fileInfo || {},
    })
  }

  async copyPart(
    sourceFileId: string,
    largeFileId: string,
    partNumber: number,
    first: number,
    last: number,
  ): Promise<{ contentSha1: string }> {
    return this.call("b2_copy_part", {
      sourceFileId,
      largeFileId,
      partNumber,
      range: `bytes=${first}-${last}`,
    })
  }

  async finishLarge(fileId: string, partSha1Array: string[]): Promise<B2File> {
    return this.call<B2File>("b2_finish_large_file", { fileId, partSha1Array })
  }

  async deleteVersion(fileName: string, fileId: string): Promise<void> {
    try {
      await this.call("b2_delete_file_version", { fileName, fileId })
    } catch (error) {
      if (!String(error).includes("not_found")) throw error
    }
  }

  async hide(fileName: string): Promise<void> {
    await this.call("b2_hide_file", {
      bucketId: await this.getBucketId(),
      fileName,
    })
  }
}
