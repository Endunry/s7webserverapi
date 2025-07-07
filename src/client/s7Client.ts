import {
  forkJoin,
  map,
  mergeMap,
  Observable,
  ObservableInput,
  ReplaySubject,
  Subject,
  Subscription,
  switchMap,
  take,
  throwError,
} from "rxjs";
import {
  BrowseFilesParams,
  BrowseFilesResult,
  BrowseTicketsParams,
  BrowseTicketsResult,
  CacheMethod,
  CloseTicketParams,
  CloseTicketResult,
  DownloadFileParams,
  DownloadFileResult,
  FileBrowseResult,
  FlattenKeys,
  GetCertificateUrlParams,
  GetPermissionsParams,
  GetPermissionsResult,
  LoginParams,
  LoginResult,
  Params,
  PingParams,
  PlcPermissions,
  ReadParams,
  ReadResult,
  RPCErrorCode,
  RPCLoginError,
  RPCMethodObject,
  RPCMethods,
  RPCResponse,
  RPCResults,
  S7DataTypes,
  S7JsonClient,
  S7WebserverClientConfig,
  TicketID,
  WebAppBrowseResourcesResponse,
  WebAppBrowseResponse,
  WriteParams,
  WriteResult,
} from "../util/types";
import { HttpRequestConfig, RxJSHttpClient } from "rxjs-http-client";
import {
  GetTransaction,
  GetTransactionHandler,
  WriteTransaction,
  WriteTransactionHandler,
} from "./WriteTransaction";
import { CacheStructure } from "./CacheStructure";
import * as murmurhash from "murmurhash";
import { SubscriberTrie } from "./Trie";

export class S7WebserverClient<T = "Structureless"> implements S7JsonClient<T> {
  protected http: RxJSHttpClient;
  protected connectionErrorObservable = new Subject<Function>();
  public onPlcConnectionReady: ReplaySubject<boolean> =
    new ReplaySubject<boolean>();

  protected loaded = false;
  protected user: string = "";
  protected token: string = "";

  protected permissionMap: Map<PlcPermissions, boolean> = new Map();
  protected permissionsSubject: ReplaySubject<PlcPermissions[]> =
    new ReplaySubject<PlcPermissions[]>(1);

  protected lastPollingTime: Date = new Date();
  protected pollingDelay: number;
  protected slowPollingMode: boolean = false;

  protected readStack: FlattenKeys<T>[] = [];
  protected lastReadStack: FlattenKeys<T>[] = [];

  protected cache = new CacheStructure<T>();
  protected pollErrorSubject = new Subject<string>();
  protected errorSubscriber = 0;

  protected writeTransactionHandler: WriteTransactionHandler<T> =
    new WriteTransactionHandler<T>();
  protected getTransactionHandler: GetTransactionHandler<T> =
    new GetTransactionHandler<T>(this.writeTransactionHandler, this.cache);

  protected subscriberCountMap: Map<FlattenKeys<T>, number> = new Map();
  protected rpcRequestHashedKeyMap = new Map<number, string>();

  protected getRequestLoadedSubject: Subject<boolean> = new Subject<boolean>();
  /**
   * Because we use flattened keys, we use a Trie-Datastructure to keep track of the subscribers.
   * When a leaf changes its value we can use the prefix-property of the trie to also call all the parents of the leaf.
   *
   * @protected
   * @type {SubscriberTrie<typeof data>}
   */
  protected subscriberTrie: SubscriberTrie<T> = new SubscriberTrie();

  /**
   * Subscriber trie for non cached values.
   *
   * @protected
   * @type {SubscriberTrie<typeof data>}
   */
  protected ignoreCacheSubscriberTrie: SubscriberTrie<T> = new SubscriberTrie();

  protected browseFilesMap: Map<string, Subject<FileBrowseResult[]>> = new Map<
    string,
    Subject<FileBrowseResult[]>
  >();
  protected downloadFileMap: Map<string, Subject<string>> = new Map();

  protected browseTicketsCounter = 0;
  protected browseTicketsMap: Map<string, Subject<BrowseTicketsResult>> =
    new Map();
  protected closeTicketMap: Map<string, Subject<CloseTicketResult>> = new Map();

  protected localStorage?: Storage;

  protected pollTimeout: NodeJS.Timeout | undefined;
  protected ticketApiUrl: string;
  constructor(
    protected baseUrl: string,
    protected config: S7WebserverClientConfig<T>,
    existingHttpClient?: RxJSHttpClient,
    ticketApiUrl?: string
  ) {
    this.config.localStoragePrefix = config.localStoragePrefix ?? "s7_";
    this.config.defaultUser = config.defaultUser ?? {
      user: "Anonymous",
      password: "",
    };

    this.ticketApiUrl = this.baseUrl.replace("jsonrpc", "ticket");

    if (ticketApiUrl != undefined) {
      this.ticketApiUrl = ticketApiUrl;
    }

    this.config.polling = config.polling ?? {
      slowMinDelay: 1000 * 60, // Every minute
      minDelay: 15,
      emaAlpha: 0.1,
      clamp: true,
    };

    this.pollingDelay = this.config.polling.minDelay;

    if (existingHttpClient != undefined) {
      this.http = existingHttpClient;
    } else {
      this.http = new RxJSHttpClient();
    }

    this.localStorage = undefined;
    if (Object.keys(this).includes("localStorage")) {
      this.localStorage = this.localStorage;
    }
    this.initDefaultErrorHandler();
  }

  //region WepApp Stuff

  uploadFileToWebApp(
    application_name: string,
    filename: string,
    media_type: string,
    data: string,
    isProtected?: boolean,
    etag?: string,
    last_modified: string | Date = new Date()
  ): Observable<boolean> {
    return new Observable((sub) => {
      const x = this.webAppCreateResource(
        application_name,
        filename,
        media_type,
        isProtected,
        etag,
        last_modified
      ).subscribe((ticketId) => {
        this.uploadToTicket(ticketId, data).subscribe(sub);
      });
      return () => {
        x.unsubscribe();
      };
    });
  }

  protected getXAuthHeader() {
    return {
      "Content-Type": "application/json",
      "X-Auth-Token": this.token,
    };
  }

  protected postRequest(
    url: string,
    headers: any,
    body: any,
    binary?: boolean
  ): Observable<any> {
    return this.http.post(url, { headers, body }).pipe(
      mergeMap((data) => {
        if (binary) {
          return data.arrayBuffer();
        } else {
          return data.json();
        }
      })
    );
  }

  uploadToTicket(ticketId: any, data: TicketID): Observable<boolean> {
    return this.postRequest(
      this.ticketApiUrl + `?id=${ticketId}`,
      { "Content-Type": "application/octet-stream" },
      data
    ).pipe(
      map(() => {
        return true;
      })
    );
  }

  webAppCreate(name: string, enabled?: boolean): Observable<boolean> {
    return this.postRequest(
      this.baseUrl,
      this.getXAuthHeader(),
      this.getAnyRPCMethodObject("WebApp.Create", {
        name,
        state: enabled ? "enabled" : "disabled",
      })
    );
  }

  webAppDelete(name: string): Observable<boolean> {
    return this.postRequest(
      this.baseUrl,
      this.getXAuthHeader(),
      this.getAnyRPCMethodObject("WebApp.Delete", {
        name,
      })
    ).pipe(map((a) => a.result));
  }

  webAppRename(name: string, new_name: string): Observable<true> {
    throw new Error("Method not implemented.");
  }

  webAppBrowse(name?: string): Observable<WebAppBrowseResponse> {
    return this.postRequest(
      this.baseUrl,
      this.getXAuthHeader(),
      this.getAnyRPCMethodObject("WebApp.Browse", {
        name,
      })
    ).pipe(map((a) => a.result));
  }
  webAppSetState(name: string, enabled: boolean): Observable<boolean> {
    return this.postRequest(
      this.baseUrl,
      this.getXAuthHeader(),
      this.getAnyRPCMethodObject("WebApp.SetState", {
        name,
        state: enabled ? "enabled" : "disabled",
      })
    ).pipe(map((a) => a.result));
  }

  webAppSetDefaultPage(
    name: string,
    resource_name: string
  ): Observable<boolean> {
    return this.postRequest(
      this.baseUrl,
      this.getXAuthHeader(),
      this.getAnyRPCMethodObject("WebApp.SetDefaultPage", {
        name,
        resource_name,
      })
    ).pipe(map((a) => a.result));
  }
  webAppSetNotFoundPage(
    name: string,
    resource_name: string
  ): Observable<boolean> {
    throw new Error("Method not implemented.");
  }
  webAppBrowseResources(
    app_name: string,
    resource_name?: string
  ): Observable<WebAppBrowseResourcesResponse> {
    return this.postRequest(
      this.baseUrl,
      this.getXAuthHeader(),
      this.getAnyRPCMethodObject("WebApp.BrowseResources", {
        app_name,
        name: resource_name,
      })
    ).pipe(map((a) => a.result));
  }
  webAppCreateResource(
    app_name: string,
    resource_name: string,
    media_type: string,
    isProtected?: boolean,
    etag?: string,
    last_modified: string | Date = new Date()
  ): Observable<TicketID> {
    return this.postRequest(
      this.baseUrl,
      this.getXAuthHeader(),
      this.getAnyRPCMethodObject("WebApp.CreateResource", {
        app_name,
        name: resource_name,
        media_type,
        visibility: isProtected ? "protected" : "public",
        etag,
        last_modified:
          typeof last_modified === "string"
            ? last_modified
            : last_modified.toISOString(),
      })
    ).pipe(map((a) => a.result));
  }
  webAppDeleteResource(
    app_name: string,
    resource_name: string
  ): Observable<boolean> {
    return this.postRequest(
      this.baseUrl,
      this.getXAuthHeader(),
      this.getAnyRPCMethodObject("WebApp.DeleteResource", {
        app_name,
        name: resource_name,
      })
    ).pipe(map((a) => a.result));
  }
  webAppRenameResource(
    app_name: string,
    resource_name: string,
    resource_new_name: string
  ): Observable<boolean> {
    throw new Error("Method not implemented.");
  }
  webAppDownloadResource(
    app_name: string,
    resource_name: string
  ): Observable<TicketID> {
    throw new Error("Method not implemented.");
  }
  webAppSetResourceVisibility(
    app_name: string,
    resource_name: string,
    is_protected: boolean
  ): Observable<boolean> {
    throw new Error("Method not implemented.");
  }
  webAppSetResourceETag(
    app_name: string,
    resource_name: string,
    etag: string
  ): Observable<boolean> {
    throw new Error("Method not implemented.");
  }
  webAppSetResourceMediaType(
    app_name: string,
    resource_name: string,
    media_type: string
  ): Observable<boolean> {
    throw new Error("Method not implemented.");
  }
  webAppSetResourceModificationTime(
    app_name: string,
    resource_name: string,
    last_modified: string | Date
  ): Observable<boolean> {
    throw new Error("Method not implemented.");
  }
  webAppSetVersion(app_name: string, version: string): Observable<boolean> {
    throw new Error("Method not implemented.");
  }
  webAppSetUrlRedirectMode(
    app_name: string,
    redirect_mode: string
  ): Observable<boolean> {
    throw new Error("Method not implemented.");
  }

  protected getFileDownloadTicket(path: string): Observable<string> {
    return new Observable((subscriber) => {
      if (this.downloadFileMap.has(path)) {
        subscriber.error(`${path} already has an active download-request`);
        subscriber.complete();
        return;
      }
      this.downloadFileMap.set(path, new Subject<string>());
      const x = this.downloadFileMap.get(path)!.subscribe(subscriber);
      return () => {
        x.unsubscribe();
      };
    });
  }

  public downloadTicket(
    ticketId: string,
    type: "text" | "arrayBuffer" | "json" = "text"
  ): Observable<string> {
    return new Observable((subscriber) => {
      this.checkStoredToken()
        .pipe(take(1))
        .subscribe(() => {
          const x = this.postRequest(
            this.ticketApiUrl + `?id=${ticketId}`,
            { "Content-Type": "application/octet-stream" },
            type === "arrayBuffer"
          ).subscribe({
            next: (sub) => subscriber.next(sub),
            complete: () => {
              this.closeTicket(ticketId).subscribe();
              subscriber.complete();
            },
            error: (err) => subscriber.error(err),
          });
          return () => {
            x.unsubscribe();
          };
        });
    });
  }

  downloadFile(path: string, binary?: boolean): Observable<string> {
    if (!this.can("read_file")) {
      return throwError(
        () => new Error(`The current user ${this.user} can't read files`)
      );
    }
    return new Observable((subscriber) => {
      const x = this.getFileDownloadTicket(path).subscribe((ticket) => {
        const y = this.downloadTicket(
          ticket,
          binary ? "arrayBuffer" : "text"
        ).subscribe(subscriber);
        return () => {
          y.unsubscribe();
        };
      });
      return () => {
        x.unsubscribe();
      };
    });
  }

  downloadFolder(
    folderPath: string
  ): Observable<(FileBrowseResult & { data: string })[]> {
    if (!this.can("read_file")) {
      return throwError(
        () => new Error(`The current user ${this.user} can't read files`)
      );
    }
    return new Observable((subscriber) => {
      const x = this.browsePath(folderPath).subscribe((result) => {
        const observableArray: Observable<string>[] = [];
        const returnObject: (FileBrowseResult & { data: string })[] = [];
        for (const entry of result) {
          if (entry.type == "dir" || entry.state == "active") {
            continue;
          }
          returnObject.push({ ...entry, data: "" });
          observableArray.push(
            this.downloadFile(folderPath + "/" + entry.name)
          );
        }
        const x = forkJoin(observableArray).subscribe((files) => {
          for (let i = 0; i < files.length; i++) {
            returnObject[i].data = files[i];
          }
          subscriber.next(returnObject);
          subscriber.complete();
        });
        return () => {
          x.unsubscribe();
        };
      });

      return () => {
        x.unsubscribe();
      };
    });
  }
  browsePath(path: string): Observable<FileBrowseResult[]> {
    return new Observable((subscriber) => {
      if (this.browseFilesMap.has(path)) {
        subscriber.error(`${path} already has an active FileBrowseRequest`);
        subscriber.complete();
        return;
      }
      this.browseFilesMap.set(path, new Subject<FileBrowseResult[]>());
      const x = this.browseFilesMap.get(path)!.subscribe(subscriber);
      return () => {
        x.unsubscribe();
      };
    });
  }
  closeAllTickets(): Observable<boolean> {
    return new Observable((sub) =>
      this.browseTickets().subscribe((ticketResult) => {
        const obs = ticketResult.tickets.map((ticket) => {
          return this.closeTicket(ticket.id);
        });

        const x = forkJoin(obs).subscribe((allClosedTickets) => {
          sub.next(allClosedTickets.every((x) => x));
          sub.complete();
        });
        () => {
          x.unsubscribe();
        };
      })
    );
  }

  browseTickets(): Observable<BrowseTicketsResult> {
    if (this.browseTicketsCounter >= 10) {
      this.browseTicketsCounter = 0;
    }
    const id = `${this.browseTicketsCounter++}`;
    if (this.browseTicketsMap.has(id)) {
      return new Observable((s) =>
        s.error(
          `Somehow there already is an browseTicket with id ${id} running`
        )
      );
    }
    this.browseTicketsMap.set(id, new Subject());
    return this.browseTicketsMap.get(id)!.asObservable();
  }

  public closeTicket(ticketId: string): Observable<CloseTicketResult> {
    const id = `${ticketId}`;
    if (this.closeTicketMap.has(id)) {
      return new Observable((s) =>
        s.error(`Already trying to close the ticket with the id ${id}`)
      );
    }
    this.closeTicketMap.set(id, new Subject());
    return this.closeTicketMap.get(id)!.asObservable();
  }

  public get onPollError() {
    this.errorSubscriber++;
    return new Observable((sub) => {
      const x = this.pollErrorSubject.subscribe((err) => sub.next(err));
      () => {
        x.unsubscribe();
        this.errorSubscriber--;
      };
    });
  }

  public start() {
    this.loadInitialCacheData();
    this.initPLCPoll();
    return this.onPlcConnectionReady.asObservable();
  }

  protected checkStoredToken(): Observable<string | undefined> {
    if (
      this.localStorage?.getItem(this.config.localStoragePrefix + "token") !=
        undefined &&
      this.localStorage?.getItem(this.config.localStoragePrefix + "user") !=
        undefined
    ) {
      // Check if
      const req = {
        body: this.getRPCMethodObject(
          RPCMethods.GetPermissions,
          undefined,
          "GETPERMISSIONS"
        ),
        headers: {
          "Content-Type": "application/json",
          "X-Auth-Token": this.localStorage?.getItem(
            this.config.localStoragePrefix + "token"
          )!,
        },
      };
      return this.postRequest(this.baseUrl, req.headers, req.body).pipe(
        map((response) => {
          if (response.error) {
            return undefined;
          }
          if (response.result?.length === 0) {
            return undefined;
          } else {
            this.setCurrentPermissions(response.result!);
            this.token = this.localStorage?.getItem(
              this.config.localStoragePrefix + "token"
            )!;
            this.user = this.localStorage?.getItem(
              this.config.localStoragePrefix + "user"
            )!;
            return this.localStorage?.getItem(
              this.config.localStoragePrefix + "user"
            )!;
          }
        })
      );
    } else {
      return new Observable((subscriber) => {
        subscriber.next();
      });
    }
  }

  /**
   * Sets the current permissions and updates the permissions subject so other components can get a live-update of the permissions.
   * E.g. if the user logs out, we may want to redirect them if theyre currently on a page they shouldnt access.
   * @param permissions
   */
  protected setCurrentPermissions(permissions: GetPermissionsResult) {
    this.permissionMap.clear();
    const perms: PlcPermissions[] = [];
    for (const permission of permissions) {
      this.permissionMap.set(permission.name, true);
      perms.push(permission.name);
    }
    this.permissionsSubject.next(perms);
  }

  getRPCMethodObject(
    method: RPCMethods.BrowseTickets,
    params: BrowseTicketsParams,
    id?: string
  ): RPCMethodObject;
  getRPCMethodObject(
    method: RPCMethods.CloseTicket,
    params: CloseTicketParams,
    id?: string
  ): RPCMethodObject;
  getRPCMethodObject(
    method: RPCMethods.Ping,
    params: PingParams,
    id?: string
  ): RPCMethodObject;
  getRPCMethodObject(
    method: RPCMethods.BrowseFiles,
    params: BrowseFilesParams,
    id?: string
  ): RPCMethodObject;
  getRPCMethodObject(
    method: RPCMethods.DownloadFile,
    params: DownloadFileParams,
    id?: string
  ): RPCMethodObject;
  getRPCMethodObject(
    method: RPCMethods.Read,
    params: ReadParams,
    id?: string
  ): RPCMethodObject;
  getRPCMethodObject(
    method: RPCMethods.Login,
    params: LoginParams,
    id?: string
  ): RPCMethodObject;
  getRPCMethodObject(
    method: RPCMethods.GetCertificateUrl,
    params: GetCertificateUrlParams,
    id?: string
  ): RPCMethodObject;
  getRPCMethodObject(
    method: RPCMethods.Write,
    params: WriteParams,
    id?: string
  ): RPCMethodObject;
  getRPCMethodObject(
    method: RPCMethods.GetPermissions,
    params: GetPermissionsParams,
    id?: string
  ): RPCMethodObject;
  getRPCMethodObject(
    method: RPCMethods,
    params: Params,
    id: string = "0"
  ): RPCMethodObject {
    return {
      jsonrpc: "2.0",
      method: method,
      params: params,
      id,
    };
  }

  protected getAnyRPCMethodObject(
    method: string,
    params: any,
    id: string = "0"
  ) {
    return {
      jsonrpc: "2.0",
      method,
      params,
      id,
    };
  }

  public initPLCPoll() {
    this.checkStoredToken()
      .pipe(take(1))
      .subscribe({
        next: (value) => {
          if (value == undefined) {
            this.login()
              .pipe(take(1))
              .subscribe({
                next: () => {
                  this.pollData();
                },
                error: () => {
                  this.connectionErrorObservable.next(() => {
                    this.initPLCPoll();
                  });
                },
              });
          } else {
            this.pollData();
          }
        },
        error: () => {
          this.connectionErrorObservable.next(() => {
            this.initPLCPoll();
          });
        },
      });
  }

  protected hashRPCMethods(set: Set<RPCMethodObject>) {
    for (const setEntry of set) {
      setEntry.id = this.getHashedId(setEntry.id).toString();
    }
  }

  protected getHashedId(humanReadableId: string): number {
    let hashedId = murmurhash(humanReadableId);
    let counter = 0;
    while (
      this.rpcRequestHashedKeyMap.has(hashedId) &&
      this.rpcRequestHashedKeyMap.get(hashedId) !== humanReadableId
    ) {
      counter++;
      hashedId = murmurhash(humanReadableId + counter.toString());
    }
    this.rpcRequestHashedKeyMap.set(hashedId, humanReadableId);

    return hashedId;
  }

  protected handleRPCResponse(responses: RPCResponse<RPCResults>[]) {
    if (this.loaded === false) {
      this.onPlcConnectionReady.next(true);
      this.loaded = true;
    }

    for (const responseKey in responses) {
      const response = responses[responseKey];
      const unhashedId = this.rpcRequestHashedKeyMap.get(+response.id);
      if (unhashedId == undefined) {
        throw new Error(
          `The Webserver-API returned an RPC-Result with an id that was not configured correctly (missed hash-id)`
        );
      }
      const responseSplit = unhashedId.split(":");
      const command = responseSplit[0];
      const key = responseSplit[1] as FlattenKeys<T>;
      const additional = responseSplit[2] as string | undefined;
      if (response.error != undefined) {
        this.handleRPCResponseError(unhashedId, response.error);
        if (command === "WRITE") {
          this.writeTransactionHandler.resolveDependentKey(
            Number(additional),
            key,
            false
          );
        } else if (command === "BROWSEFILES") {
          this.browseFilesMap.get(key as string)?.complete();
          this.browseFilesMap.delete(key as string);
        } else if (command === "DOWNLOADFILE") {
          this.downloadFileMap.get(key as string)?.complete();
          this.downloadFileMap.delete(key as string);
        } else if (command === "BROWSETICKETS") {
          this.browseTicketsMap.get(key as string)?.complete();
          this.browseTicketsMap.delete(key as string);
        } else if (command === "CLOSETICKET") {
          this.closeTicketMap.get(key as string)?.complete();
          this.closeTicketMap.delete(key as string);
        }
        continue;
      }

      switch (command) {
        case "READ":
          this.getTransactionHandler.resolveDependentKey(
            Number(additional),
            key,
            response.result!
          );
          this.handleRPCResponseRead(
            key,
            response as RPCResponse<RPCMethods.Read>
          );
          break;
        case "WRITE":
          this.handleRPCResponseWrite(
            key,
            response as RPCResponse<WriteResult>,
            Number(additional)
          );
          break;
        case "BROWSEFILES": {
          if (this.browseFilesMap.has(key as string)) {
            this.browseFilesMap
              .get(key as string)!
              .next((response.result as BrowseFilesResult).resources);
            this.browseFilesMap.get(key as string)!.complete();
            this.browseFilesMap.delete(key as string);
          } else {
            throw new Error(
              "Getting a BrowseFiles-Response without an active BrowseFiles-Request"
            );
          }
          break;
        }
        case "DOWNLOADFILE": {
          if (this.downloadFileMap.has(key as string)) {
            this.downloadFileMap
              .get(key as string)!
              .next(response.result as DownloadFileResult);
            this.downloadFileMap.get(key as string)!.complete();
            this.downloadFileMap.delete(key as string);
          } else {
            throw new Error(
              "Getting a DownloadFile-Response without an active DownloadFile-Request"
            );
          }
          break;
        }
        case "BROWSETICKETS": {
          if (this.browseTicketsMap.has(key as string)) {
            this.browseTicketsMap
              .get(key as string)!
              .next(response.result as BrowseTicketsResult);
            this.browseTicketsMap.get(key as string)!.complete();
            this.browseTicketsMap.delete(key as string);
          } else {
            throw new Error(
              "Getting a BrowseTickets-Response without an active BrowseTickets-Request"
            );
          }
          break;
        }
        case "CLOSETICKET": {
          if (this.closeTicketMap.has(key as string)) {
            this.closeTicketMap
              .get(key as string)!
              .next(response.result as CloseTicketResult);
            this.closeTicketMap.get(key as string)!.complete();
            this.closeTicketMap.delete(key as string);
          } else {
            throw new Error(
              "Getting a CloseTicket-Response without an active CloseTicket-Request"
            );
          }
          break;
        }
      }
    }
  }

  protected handleRPCResponseRead(
    key: FlattenKeys<T>,
    reponse: RPCResponse<ReadResult>
  ) {
    const oldValue = this.cache.getCopy(key);
    this.cache.writeEntry(key, reponse.result);
    if (oldValue !== this.cache.getReference(key)) {
      this.subscriberTrie.notifySubscriber(key, this.cache.cacheObject);
    }
    this.ignoreCacheSubscriberTrie.notifySubscriber(
      key,
      this.cache.cacheObject
    );
  }

  protected handleRPCResponseWrite(
    key: FlattenKeys<T>,
    response: RPCResponse<WriteResult>,
    writeTransactionId: number
  ) {
    const oldValue = this.cache.getCopy(key);
    this.writeTransactionHandler.resolveDependentKey(
      writeTransactionId,
      key,
      response.result as boolean,
      this.cache
    );
    if (oldValue !== this.cache.getReference(key)) {
      this.subscriberTrie.notifySubscriber(key, this.cache.cacheObject);
    }
    this.ignoreCacheSubscriberTrie.notifySubscriber(
      key,
      this.cache.cacheObject
    );
  }

  /**
   * Or better, maybe call the subscriber on error. Maybe create a error-subject that can be subscribed to and display the error somewhere in the UI.
   * @param id rpc-id
   * @param error RPC-Error Object
   */
  protected handleRPCResponseError(
    id: string,
    error: { code: RPCErrorCode; message: string }
  ) {
    switch (error.code) {
      case RPCErrorCode.PERMISSON_DENIED: {
        this.pollErrorSubject.next(
          `You're not allowed to execute this operation: ${id}`
        );
        break;
      }
      case RPCErrorCode.ADRESS_NOT_FOUND: {
        this.pollErrorSubject.next(
          `The address ${id} was not found in the PLC`
        );
        break;
      }
      case RPCErrorCode.UNSUPPORTED_ADRESS: {
        this.pollErrorSubject.next(
          `The adress ${id} is not reaching an atomic value like a Real, Int or String. But an Struct/Array. This is not supported by the API`
        );
      }
      default:
        this.pollErrorSubject.next(
          `Error in RPC-Response with id: ${id} and error: ${error.code}: ${error.message}`
        );
    }
  }

  // MARK: Polling-Cycle
  /**
   * This is the polling-cycle that will be called recursivley. It collects all the RPC-Methods that need to be called.
   * It collects one time get- and write-requests and subscriber-requests. It then sends the requests to the PLC and collects them.
   *
   * If an network-error occurs, the connectionErrorObservable is called with a callback function. This is primarily used to retry connection attempts. Currently we display a error-toast with a retry button that calls this callback function.
   *
   *
   * @returns
   */
  pollData(once: boolean = false) {
    this.lastPollingTime = new Date();

    const headers = {
      "Content-Type": "application/json",
      "X-Auth-Token": this.token,
    };

    const jsonRPC = this.collectRPCMethodObjects();
    /**
     * The id is used for actually identifiying which logical request was made like READ:<hmi-key>
     * This is good for the code and for debug purposes, however if we send multiple requests at once this id is really big
     * An string can easily be 100+ chars long. So we hash it to a number, which reduces the data send over http.
     */
    this.hashRPCMethods(jsonRPC);
    this.postRequest(this.baseUrl, headers, Array.from(jsonRPC))
      .pipe(take(1))
      .subscribe({
        next: (response) => {
          this.handleRPCResponse(response);
          this.getRequestLoadedSubject.next(true);
          this.lastReadStack = [];
        },
        error: () => {
          this.connectionErrorObservable.next(() => {
            this.pollData(once);
          });
        },
        complete: () => {
          if (once) {
            return;
          }
          this.recalculatePollingDelay();
          this.pollTimeout = setTimeout(() => {
            this.pollData();
          }, this.pollingDelay);
        },
      });
  }

  protected recalculatePollingDelay() {
    this.exponentialMovingAverage();
    if (this.config.polling.clamp === true) {
      this.clampPollingDelay();
    }
  }

  protected exponentialMovingAverage() {
    const timeDiff = new Date().getTime() - this.lastPollingTime.getTime();
    const emaAlpha = this.config.polling.emaAlpha;
    this.pollingDelay =
      emaAlpha * timeDiff + (1 - emaAlpha) * this.pollingDelay;
  }

  protected clampPollingDelay() {
    if (this.slowPollingMode) {
      this.pollingDelay = Math.max(
        this.config.polling.slowMinDelay,
        this.pollingDelay
      );
    } else {
      this.pollingDelay = Math.max(
        this.config.polling.minDelay,
        this.pollingDelay
      );
    }
  }

  collectFileRPCMethodObject(objectSet: Set<RPCMethodObject>): void {
    for (const key of this.downloadFileMap.keys()) {
      objectSet.add(
        this.getRPCMethodObject(
          RPCMethods.DownloadFile,
          { resource: key },
          `DOWNLOADFILE:${key}`
        )
      );
    }

    for (const key of this.browseFilesMap.keys()) {
      objectSet.add(
        this.getRPCMethodObject(
          RPCMethods.BrowseFiles,
          { resource: key },
          `BROWSEFILES:${key}`
        )
      );
    }
  }

  collectTicketRPCMethodObjects(objectSet: Set<RPCMethodObject>): void {
    for (const key of this.closeTicketMap.keys()) {
      objectSet.add(
        this.getRPCMethodObject(
          RPCMethods.CloseTicket,
          { id: key },
          `CLOSETICKET:${key}`
        )
      );
    }

    for (const key of this.browseTicketsMap.keys()) {
      objectSet.add(
        this.getRPCMethodObject(
          RPCMethods.BrowseTickets,
          null,
          `BROWSETICKETS:${key}`
        )
      );
    }
  }
  /**
   * Collects all the different RPC-Methods that should be called on a polling-cycle.
   *
   */
  protected collectRPCMethodObjects(): Set<RPCMethodObject> {
    const set = new Set<RPCMethodObject>();
    this.collectGetRPCMethodObjects(set);
    this.collectWriteRPCMethodObjects(set);
    this.collectSubscribeRPCMethodObjects(set);
    this.collectFileRPCMethodObject(set);
    this.collectTicketRPCMethodObjects(set);
    // IMPORTANT: This function should be the last function that is called in the collection of RPC Methods.
    this.collectStaticRPCMethodObjects(set);
    return set;
  }

  protected collectWriteRPCMethodObjects(
    objectSet: Set<RPCMethodObject>
  ): void {
    this.writeTransactionHandler.getAllTransactionsKeys().forEach((key) => {
      const transaction = this.writeTransactionHandler.getTransaction(key);
      if (transaction == undefined) {
        throw new Error(
          `Error while trying to collect the write RPC-Method Objects. The transaction with id ${key} is undefined.`
        );
      }
      this.collectChildrenKeys(
        transaction.keys[0],
        objectSet,
        RPCMethods.Write,
        Infinity,
        transaction.value,
        transaction
      );
    });
  }

  protected collectSubscribeRPCMethodObjects(
    objectSet: Set<RPCMethodObject>
  ): void {
    Array.from(this.subscriberCountMap.entries())
      .filter(([, value]) => value > 0)
      .forEach(([key]) => {
        // For every key in the subscriberCountMap that has a positive-counter value;
        this.collectChildrenKeys(key, objectSet, RPCMethods.Read, Infinity);
      });
  }

  /**
   * When calling the get-Function, we just return the Subject in the subscriber-Trie and return the value once.
   * Then we append the hmi-key value to our read-Stack. Which we then collect here, by filling in the children keys and calling the get-Method on the server for the key. Later we identify the results and write it into the cache, which then triggers the subject.
   *
   * In case we never successfully read, we save the lastReadStack and delete it after a successful polling-cycle. That way, if we retry the connection, we do not lose the read information.
   * @param objectSet
   */
  protected collectGetRPCMethodObjects(objectSet: Set<RPCMethodObject>): void {
    this.getTransactionHandler
      .getAllTransactionsKeys()
      .forEach((getTransactionId) => {
        const transaction =
          this.getTransactionHandler.getTransaction(getTransactionId);
        if (transaction == undefined) {
          throw new Error(
            `Error while trying to collect the get RPC-Method Objects. The transaction with id ${getTransactionId} is undefined.`
          );
        }
        for (const key of transaction.internalReadStack) {
          this.collectChildrenKeys(
            key[0],
            objectSet,
            RPCMethods.Read,
            key[1],
            transaction.value,
            transaction
          );
        }
      });

    // this.lastReadStack.forEach((element) => {
    //     this.collectChildrenKeys(element, objectSet, RPCMethods.Read);
    // });

    // this.readStack.forEach((element) => {
    //     this.collectChildrenKeys(element, objectSet, RPCMethods.Read);
    // });

    // // Clear the stack
    // this.lastReadStack = this.readStack;
    // this.readStack = [];
  }

  protected collectChildrenKeys(
    key: FlattenKeys<T>,
    objectSet: Set<RPCMethodObject>,
    method: RPCMethods.Read | RPCMethods.Write,
    depth: number,
    value?: S7DataTypes,
    transaction?: WriteTransaction<T> | GetTransaction<T>
  ): void {
    const plcKey = this.insertPrefixMapping(key);
    const keys = this.cache.parseFlattenedKey(plcKey);
    let ref = this.config.plcStructure;

    if (ref == undefined) {
      // This means, the user never configured the structure. So we cant fill in the details. We basically just create a read/write instruction for this key.

      const plcVar = this.hmiKeyToPlcKey(key);
      if (method === RPCMethods.Read) {
        if (transaction != undefined) {
          objectSet.add(
            this.getRPCMethodObject(
              method,
              { var: plcVar },
              `READ:${key}:${transaction?.id}`
            )
          );
          transaction?.addDependentKey(key);
        } else {
          objectSet.add(
            this.getRPCMethodObject(method, { var: plcVar }, `READ:${key}`)
          );
        }
      } else if (method === RPCMethods.Write) {
        if (typeof value === "object" || Array.isArray(value)) {
          throw Error(
            `Trying to write the value ${value} to the key ${key}. The given value is an object and not a single value. You never specified the Structure of the PLC-DBs anywhere. Thus we cant fill in the missing keys here. Either you missed something, or you need to specify the plc-Structure and pass it into the constructor-config of the S7WebserverClient (config.plcStructure).`
          );
        }
        objectSet.add(
          this.getRPCMethodObject(
            RPCMethods.Write,
            { value: value ?? "", var: plcVar },
            `WRITE:${key}:${transaction?.id}`
          )
        );
        transaction?.addDependentKey(key);
      }

      return;
    }

    for (const key of keys) {
      ref = CacheStructure.getNextReference(ref, key.toString());
    }

    // Call the recursion-call with newKey = '', so it just takes the first key as entrance
    this._collectChildrenKeys(
      key,
      objectSet,
      ref,
      "",
      method,
      depth,
      value,
      transaction
    );
  }

  protected _collectChildrenKeys(
    wholeKey: FlattenKeys<T>,
    objectSet: Set<RPCMethodObject>,
    ref: S7DataTypes,
    newKey: string,
    method: RPCMethods.Read | RPCMethods.Write,
    depth: number,
    value?: S7DataTypes,
    transaction?: WriteTransaction<T> | GetTransaction<T>
  ) {
    if (depth < 0) {
      console.warn(`Depth reached!: ${wholeKey}`);
      return;
    }

    if (
      method === RPCMethods.Write &&
      (value == undefined || transaction == undefined)
    ) {
      throw new Error(
        `Error while trying to fill in children keys for JSONRPC-Request. Trying to create JSONRPC-Method Object to write to ${wholeKey}, but the relative value or writeTransaction is undefined!`
      );
    }

    ref = CacheStructure.getNextReference(ref, newKey);
    value = CacheStructure.getNextReference(value, newKey);

    if (Array.isArray(ref)) {
      for (let i = 0; i < ref.length; i++) {
        const newKey = (wholeKey + `.${i}`) as FlattenKeys<T>;
        if (ref[i] === undefined) {
          ref[i] = "";
        }
        this._collectChildrenKeys(
          newKey,
          objectSet,
          ref,
          i.toString(),
          method,
          depth - 1,
          value,
          transaction
        );
      }
      return;
    }

    if (typeof ref === "object") {
      for (const key in ref) {
        const newKey = (wholeKey + `.${key}`) as FlattenKeys<T>;
        this._collectChildrenKeys(
          newKey,
          objectSet,
          ref,
          key,
          method,
          depth - 1,
          value,
          transaction
        );
      }
      return;
    }

    if (ref === undefined) {
      throw new Error(
        `Error while trying to fill in children keys for JSONRPC-Request. Trying to create JSONRPC-${
          method === RPCMethods.Write ? "WRITE" : "READ"
        }-Method Object to key "${newKey}" (wholeKey: ${wholeKey})! The relative reference to the PLC-DB-structure returned undefined. Which either means, a wrong key was provided that does not exist in the configured PLC-Structure, or the PLC-DB-Structure is faulty and the provided key is missing.`
      );
    }

    const plcVar = this.hmiKeyToPlcKey(wholeKey);

    if (method === RPCMethods.Read) {
      if (transaction != undefined) {
        objectSet.add(
          this.getRPCMethodObject(
            method,
            { var: plcVar },
            `READ:${wholeKey}:${transaction?.id}`
          )
        );
        transaction?.addDependentKey(wholeKey);
      } else {
        objectSet.add(
          this.getRPCMethodObject(method, { var: plcVar }, `READ:${wholeKey}`)
        );
      }
    } else if (method === RPCMethods.Write) {
      if (typeof value === "object" || Array.isArray(value)) {
        throw Error(
          `Error while trying to fill in children keys for JSONRPC-Request. Trying to create JSONRPC-Write-Method to key "${newKey}" (wholeKey: ${wholeKey}). According to the PLC-Structure this key is atomic and shouldnt be of type Array|Object. However the provided value: ${JSON.stringify(
            value
          )} appears to not be atomic.`
        );
      }
      objectSet.add(
        this.getRPCMethodObject(
          RPCMethods.Write,
          { value: value ?? "", var: plcVar },
          `WRITE:${wholeKey}:${transaction?.id}`
        )
      );
      transaction?.addDependentKey(wholeKey);
    }
  }

  /**
   * Turns a HMI-Key into a PLC-Key. Given the information about the mapping of the HMI to the PLC.
   * We also have to replace the Index-signatures for arrays with the correct syntax for the PLC (basically just wrapping the index in square bracktes and removing the dot before the square bracket) someObject.somearray.0 -> someObject.somearray[0]
   * @param key Hmi-Key
   * @returns
   */
  protected hmiKeyToPlcKey(key: FlattenKeys<T>): string {
    const mappedKey = this.insertPrefixMapping(key);
    return mappedKey
      .split(".")
      .map((element) => (isNaN(Number(element)) ? element : `[${element}]`))
      .join(".")
      .replace(/\.\[/g, "[");
  }

  /**
   * Inserts the PLC-Prefix based on the configured mapping.
   * @param key Hmi-Key
   * @returns PLC-Key
   */
  protected insertPrefixMapping(key: FlattenKeys<T>): string {
    // Go through the whole this.hmiPlcMapping and check if the key is a prefix of any key in the mapping. If it is, replace the prefix with the mapping. Go through the whole list first and look for the longest prefix. Use that one.
    let longestPrefix = "";
    for (const mappingKey in this.config.prefixSubstitutionMap) {
      if (
        (key as string).startsWith(mappingKey) &&
        mappingKey.length > longestPrefix.length
      ) {
        longestPrefix = mappingKey;
      }
    }

    if (longestPrefix === "") {
      return key as string;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (key as string).replace(
      longestPrefix,
      (this.config.prefixSubstitutionMap as any)[longestPrefix as any]
    );
  }

  /**
   * This function should be the last function that is called in the collection of RPC Methods.
   * If the Set is empty by the time it reaches here, a ping gets added and a "slow Mode" is activated.
   * When we dont subscribe to any values, we dont need to poll the PLC as often as usual and clamp the polling delay to a higher value. Because the only things we need to poll are errors and the ping basically.
   *
   * @param objectSet Object set that stores the RPC-Methods
   */
  protected collectStaticRPCMethodObjects(
    objectSet: Set<RPCMethodObject>
  ): void {
    if (objectSet.size === 0) {
      this.slowPollingMode = true;
      objectSet.add(
        this.getRPCMethodObject(RPCMethods.Ping, undefined, "PING")
      );
    } else {
      this.slowPollingMode = false;
    }
  }

  /**
   * Calls the get-Function for each configured initial-Cache key.
   * @returns
   */
  protected loadInitialCacheData() {
    if (this.config.initialCacheKeys == undefined) return;
    for (const cacheKey of this.config.initialCacheKeys) {
      this.get(cacheKey).pipe(take(1)).subscribe();
    }
  }

  protected hmiKeysLoaded(key: FlattenKeys<T> | FlattenKeys<T>[]): boolean {
    if (Array.isArray(key)) {
      for (const singleKey of key) {
        if (!this.cache.entryExists(singleKey)) {
          return false;
        }
      }
      return true;
    }
    return this.cache.entryExists(key);
  }

  protected toggleBackSlowMode() {
    if (this.slowPollingMode === true) {
      // Then last poll was slowmode, so recall it with fast mode
      if (this.pollTimeout !== undefined) {
        clearTimeout(this.pollTimeout);
      }
      this.pollingDelay = this.config.polling.minDelay;
      this.pollTimeout = setTimeout(() => this.pollData(), this.pollingDelay);
    }
    this.slowPollingMode = false;
  }

  //MARK: GET

  public get<K = S7DataTypes>(
    key: FlattenKeys<T> | FlattenKeys<T>[],
    cacheMode?: CacheMethod,
    depth: number = Infinity
  ): Observable<K> {
    const keys: FlattenKeys<T>[] = Array.isArray(key) ? key : [key];

    const transaction = this.getTransactionHandler.createTransaction(
      keys,
      cacheMode,
      depth
    ) as Observable<K>;

    if (this.slowPollingMode) {
      this.slowPollingMode = false;
      this.pollingDelay = this.config.polling?.minDelay ?? 10;
      clearTimeout(this.pollTimeout);
      this.pollTimeout = setTimeout(() => {
        this.pollData();
      }, 0);
    }

    return transaction;
  }

  // protected _getFromCache<K>(keys: FlattenKeys<T>[]) {
  //     return new Observable<K>(subscriber => {
  //         subscriber.next(this.concatenateCacheFromKeys(keys) as K);
  //         subscriber.complete();
  //     })
  // }

  protected concatenateCacheFromKeys(keys: FlattenKeys<T>[]) {
    if (keys.length === 1) {
      return this.cache.getCopy(keys[0]) as S7DataTypes;
    }
    const concatenatedObject: { [key: string]: S7DataTypes } = {};
    for (const key of keys) {
      const keySplit = (key as string).split(".");
      let lastKey = keySplit[keySplit.length - 1];
      let backIndex = 1;
      while (concatenatedObject[lastKey] != undefined) {
        if (keySplit[keySplit.length - 1 - backIndex]) {
          throw new Error(
            `Trying to concatenate multiple read-key-results into a single Object. Encountered the error, that at least 2 keys have the same identifier. When asking for the keys ['someparent.x', 'someparent.y'] the resulting object will be {x: ..., y: ...}.\n however, if the keys are ['someparent.y', 'someotherparent.y'] y and y collides. So the keys are {"someparent.x": ..., "someparent.y": ...}. This error is displayed if both the keys will result in the same target-plc key (when using prefix-mapping).`
          );
        }
        lastKey = keySplit[keySplit.length - 1 - backIndex] + "." + lastKey;
        backIndex++;
      }
      concatenatedObject[lastKey] = this.cache.getCopy(key);
    }
    return concatenatedObject;
  }

  //MARK: WRITE

  public write<K = S7DataTypes>(
    key: FlattenKeys<T>,
    value: K
  ): Observable<S7DataTypes> {
    this.toggleBackSlowMode();

    return this.writeTransactionHandler.createTransaction(
      [key],
      value as S7DataTypes
    );
  }

  protected initDefaultErrorHandler() {
    this.pollErrorSubject.subscribe((err) => {
      if (this.errorSubscriber == 0) {
        console.error(err);
      }
    });
  }

  // MARK: SUBSCRIBE
  public subscribe<K = S7DataTypes>(
    key: FlattenKeys<T> | FlattenKeys<T>[],
    ignoreCache?: boolean
  ): Observable<{ value: K; changedKey: string }> {
    const keys: FlattenKeys<T>[] = Array.isArray(key) ? key : [key];

    const subscriberObject = ignoreCache
      ? this.ignoreCacheSubscriberTrie
      : this.subscriberTrie;

    return new Observable((sub) => {
      const x: Subscription[] = [];
      if (!ignoreCache && this.hmiKeysLoaded(keys)) {
        sub.next({
          value: this.concatenateCacheFromKeys(keys) as K,
          changedKey: "",
        });
      }
      keys.forEach((key) => {
        if (!subscriberObject.has(key)) {
          subscriberObject.insert(key);
        }
        subscriberObject.incrementSubscriberCount(key);
        if (this.subscriberCountMap.has(key)) {
          this.subscriberCountMap.set(
            key,
            this.subscriberCountMap.get(key)! + 1
          );
        } else {
          this.subscriberCountMap.set(key, 1);
        }
        const subscription = subscriberObject.get(key)!.subscribe((value) => {
          sub.next({
            value: this.concatenateCacheFromKeys(keys) as K,
            changedKey: value.changedKey,
          });
        });
        x.push(subscription);
      });
      this.toggleBackSlowMode();

      return () => {
        for (const key of keys) {
          subscriberObject.decrementSubscriberCount(key);
          if (this.subscriberCountMap.has(key)) {
            this.subscriberCountMap.set(
              key,
              Math.max(0, this.subscriberCountMap.get(key)! - 1)
            );
          }
        }
        x.forEach((sub) => sub.unsubscribe());
      };
    });
  }

  public get currentUser(): string {
    return this.user;
  }

  public can(permission: PlcPermissions): boolean {
    return this.permissionMap.get(permission) ?? false;
  }

  public getPermissionsUpdates(): Observable<PlcPermissions[]> {
    return this.permissionsSubject.asObservable();
  }

  public login(
    user: string = this.config.defaultUser.user,
    password: string = this.config.defaultUser.password
  ): Observable<
    | true
    | {
        code: RPCErrorCode;
        message: string;
      }
  > {
    const req: Partial<HttpRequestConfig> = {
      headers: {
        "Content-Type": "application/json",
      },
      body: [
        this.getRPCMethodObject(RPCMethods.Login, { user, password }, "LOGIN"),
        this.getRPCMethodObject(
          RPCMethods.GetPermissions,
          undefined,
          "GETPERMISSIONS"
        ),
      ],
    };
    return this.postRequest(this.baseUrl, req.headers, req.body).pipe(
      map((response) => {
        const loginResponse = response[0];
        if (loginResponse.error) {
          return loginResponse.error;
        }

        const permissionResult = response[1];
        this.token = loginResponse.result!.token;
        this.user = user;
        try {
          this.localStorage?.setItem(
            this.config.localStoragePrefix + "token",
            this.token
          );
          this.localStorage?.setItem(
            this.config.localStoragePrefix + "user",
            this.user
          );
        } catch {
          console.error("Error setting token in localStorage");
        }
        this.setCurrentPermissions(permissionResult.result!);
        return true;
      })
    );
  }
}
