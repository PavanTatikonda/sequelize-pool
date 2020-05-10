// @flow strict

const Deferred = require("./Deferred");

/*::
type LogLevel = "verbose" | "info" | "error";
type FactoryLogger = (string, LogLevel) => void;

// Various resources
type RawResource = mixed;
type PooledObject = {
  resource: RawResource,
  timeout: number,
  useCount: number,
};
type InUseObject = {
  resource: RawResource,
  useCount: number,
};

// Pool options
type Factory = {
  name: string,
  create: () => Promise<mixed>,
  destroy: (mixed) => void,
  validate: (RawResource) => boolean,
  max: number,
  min: number,
  maxUses?: number,
  idleTimeoutMillis?: number,
  acquireTimeoutMillis?: number,
  reapIntervalMillis?: number,
  log?: FactoryLogger | boolean,
};

// Pool interface
interface Poolable {
  constructor(factory: Factory): void;
  acquire(): Promise<mixed>;
  release(resource: RawResource): void;
  destroy(resource: RawResource): void;
  drain(): Promise<void>;
  destroyAllNow(): Promise<void>;
};
*/

/**
 * Generate an object pool with a specified `factory`.
 *
 * @param {Object} factory
 *   Factory to be used for generating and destroying the items.
 * @param {String} [factory.name]
 *   Name of the factory. Serves only logging purposes.
 * @param {Function} factory.create
 *   Should create the item to be acquired.
 * @param {Function} factory.destroy
 *   Should gently close any resources that the item is using.
 *   Called before the items is destroyed.
 * @param {Function} factory.validate
 *   Should return true if connection is still valid and false
 *   If it should be removed from pool. Called before item is
 *   acquired from pool.
 * @param {Number} factory.max
 *   Maximum number of items that can exist at the same time.
 *   Any further acquire requests will be pushed to the waiting list.
 * @param {Number} factory.min
 *   Minimum number of items in pool (including in-use).
 *   When the pool is created, or a resource destroyed, this minimum will
 *   be checked. If the pool resource count is below the minimum, a new
 *   resource will be created and added to the pool.
 * @param {Number} [factory.maxUses=Infinity]
 *   The number of times an item is to be used before it is destroyed
 *   no matter whether it is still healthy.  A value of 0 indicates the
 *   item should be used indefinitely so long as it is healthy.
 *   This can help with "re-balancing" connections when pool members behind
 *   a load balancer are added but are not being adopted due to pools being
 *   full of pre-existing persistent connections.
 * @param {Number} [factory.idleTimeoutMillis=30000]
 *   Delay in milliseconds after which available resources in the pool will be destroyed.
 *   This does not affects pending acquire requests.
 * @param {Number} [factory.acquireTimeoutMillis=30000]
 *   Delay in milliseconds after which pending acquire request in the pool will be rejected.
 *   Pending acquires are acquire calls which are yet to receive an response from factory.create
 * @param {Number} [factory.reapIntervalMillis=1000]
 *   Clean up is scheduled in every `factory.reapIntervalMillis` milliseconds.
 * @param {Boolean|Function} [factory.log=false]
 *   Whether the pool should log activity. If function is specified,
 *   that will be used instead. The function expects the arguments msg, loglevel
 */
class Pool /*:: implements Poolable */ {
  /*::
  _factory: Factory;
  _count: number;
  _draining: boolean;

  idleTimeoutMillis: number = 30000;
  acquireTimeoutMillis: number = 30000;
  reapIntervalMillis: number = 1000;
  log: FactoryLogger | boolean = false;
  _maxUsesPerResource: number = Infinity;

  // queues
  _pendingAcquires: Deferred[];
  _inUseObjects: InUseObject[];
  _availableObjects: PooledObject[];

  // timing controls
  _removeIdleTimer: TimeoutID;
  _removeIdleScheduled: boolean;
  */

  /**
   * Generate an object pool with a specified `factory`.
   */
  constructor(factory /* : Factory*/) {
    if (!factory.create) {
      throw new Error("create function is required");
    }

    if (!factory.destroy) {
      throw new Error("destroy function is required");
    }

    if (!factory.validate) {
      throw new Error("validate function is required");
    }

    if (
      typeof factory.min !== "number" ||
      factory.min < 0 ||
      factory.min !== Math.round(factory.min)
    ) {
      throw new Error("min must be an integer >= 0");
    }

    if (
      typeof factory.max !== "number" ||
      factory.max <= 0 ||
      factory.max !== Math.round(factory.max)
    ) {
      throw new Error("max must be an integer > 0");
    }

    if (factory.min > factory.max) {
      throw new Error("max is smaller than min");
    }

    if (
      factory.maxUses !== undefined &&
      (typeof factory.maxUses !== "number" || factory.maxUses < 0)
    ) {
      throw new Error("maxUses must be an integer >= 0");
    }

    // defaults
    this.idleTimeoutMillis = factory.idleTimeoutMillis || 30000;
    this.acquireTimeoutMillis = factory.acquireTimeoutMillis || 30000;
    this.reapIntervalMillis = factory.reapIntervalMillis || 1000;
    this._maxUsesPerResource = factory.maxUses || Infinity;
    this.log = factory.log || false;

    this._factory = factory;
    this._count = 0;
    this._draining = false;

    // queues
    this._pendingAcquires = [];
    this._inUseObjects = [];
    this._availableObjects = [];

    // timing controls
    this._removeIdleScheduled = false;
  }

  get size() {
    return this._count;
  }

  get name() {
    return this._factory.name;
  }

  get available() {
    return this._availableObjects.length;
  }

  get using() {
    return this._inUseObjects.length;
  }

  get waiting() {
    return this._pendingAcquires.length;
  }

  get maxSize() {
    return this._factory.max;
  }

  get minSize() {
    return this._factory.min;
  }

  /**
   * logs to console or user defined log function
   *
   * @param {string} message
   * @param {string} level
   *
   * @private
   */
  _log(message /*: string*/, level /*: LogLevel*/) {
    if (typeof this.log === "function") {
      this.log(message, level);
    } else if (this.log) {
      console.log(`${level.toUpperCase()} pool ${this.name} - ${message}`);
    }
  }

  /**
   * Checks and removes the available (idle) clients that have timed out.
   *
   * @private
   */
  _removeIdle() {
    const toRemove = [];
    const now = Date.now();
    let i;
    let available = this._availableObjects.length;
    const maxRemovable = this.size - this.minSize;
    let timeout;

    this._removeIdleScheduled = false;

    // Go through the available (idle) items,
    // check if they have timed out
    for (i = 0; i < available && maxRemovable > toRemove.length; i++) {
      timeout = this._availableObjects[i].timeout;
      if (now >= timeout) {
        // Client timed out, so destroy it.
        this._log(
          "removeIdle() destroying obj - now:" + now + " timeout:" + timeout,
          "verbose"
        );
        toRemove.push(this._availableObjects[i].resource);
      }
    }

    toRemove.forEach(this.destroy, this);

    // NOTE: we are re-calculating this value because it may have changed
    // after destroying items above
    // Replace the available items with the ones to keep.
    available = this._availableObjects.length;

    if (available > 0) {
      this._log("this._availableObjects.length=" + available, "verbose");
      this._scheduleRemoveIdle();
    } else {
      this._log("removeIdle() all objects removed", "verbose");
    }
  }

  /**
   * Schedule removal of idle items in the pool. More schedules cannot run concurrently.
   *
   * @private
   */
  _scheduleRemoveIdle() {
    if (!this._removeIdleScheduled) {
      this._removeIdleScheduled = true;
      this._removeIdleTimer = setTimeout(() => {
        this._removeIdle();
      }, this.reapIntervalMillis);
    }
  }

  /**
   * Try to get a new client to work, and clean up pool unused (idle) items.
   *
   *  - If there are available clients waiting, pop the first one out (LIFO),
   *    and call its callback.
   *  - If there are no waiting clients, try to create one if it won't exceed
   *    the maximum number of clients.
   *  - If creating a new client would exceed the maximum, add the client to
   *    the wait list.
   *
   * @private
   */
  _dispense() {
    let wrappedResource = null;
    const waitingCount = this._pendingAcquires.length;

    this._log(
      `dispense() clients=${waitingCount} available=${this._availableObjects.length}`,
      "info"
    );

    if (waitingCount < 1) {
      return;
    }

    while (this._availableObjects.length > 0) {
      this._log("dispense() - reusing obj", "verbose");
      wrappedResource = this._availableObjects[
        this._availableObjects.length - 1
      ];
      if (!this._factory.validate(wrappedResource.resource)) {
        this.destroy(wrappedResource.resource);
        continue;
      }

      this._availableObjects.pop();
      this._addResourceToInUseObjects(
        wrappedResource.resource,
        wrappedResource.useCount
      );

      const deferred = this._pendingAcquires.shift();
      return deferred.resolve(wrappedResource.resource);
    }

    if (this.size < this.maxSize) {
      this._createResource();
    }
  }

  _createResource() {
    this._count += 1;
    this._log(
      `createResource() - creating obj - count=${this.size} min=${this.minSize} max=${this.maxSize}`,
      "verbose"
    );

    this._factory
      .create()
      .then((resource) => {
        const deferred = this._pendingAcquires.shift();

        if (deferred) {
          this._addResourceToInUseObjects(resource, 0);
          deferred.resolve(resource);
        } else {
          this._addResourceToAvailableObjects(resource, 0);
        }
      })
      .catch((error) => {
        const deferred = this._pendingAcquires.shift();

        this._count -= 1;
        if (this._count < 0) this._count = 0;
        if (deferred) {
          deferred.reject(error);
        }
        process.nextTick(() => {
          this._dispense();
        });
      });
  }

  _addResourceToAvailableObjects(
    resource /*: RawResource*/,
    useCount /*: number*/
  ) {
    const wrappedResource = {
      resource: resource,
      useCount: useCount,
      timeout: Date.now() + this.idleTimeoutMillis,
    };

    this._availableObjects.push(wrappedResource);
    this._dispense();
    this._scheduleRemoveIdle();
  }

  _addResourceToInUseObjects(
    resource /*: RawResource*/,
    useCount /*: number*/
  ) {
    const wrappedResource = {
      resource: resource,
      useCount: useCount,
    };
    this._inUseObjects.push(wrappedResource);
  }

  _ensureMinimum() {
    let i, diff;
    if (!this._draining && this.size < this.minSize) {
      diff = this.minSize - this.size;
      for (i = 0; i < diff; i++) {
        this._createResource();
      }
    }
  }

  /**
   * Requests a new resource. This will call factory.create to request new resource.
   *
   * It will be rejected with timeout error if `factory.create` didn't respond
   * back within specified `acquireTimeoutMillis`
   *
   * @returns {Promise<Object>}
   */
  acquire() {
    if (this._draining) {
      return Promise.reject(
        new Error("pool is draining and cannot accept work")
      );
    }

    const deferred = new Deferred();
    deferred.registerTimeout(this.acquireTimeoutMillis, () => {
      // timeout triggered, promise will be rejected
      // remove this object from pending list
      this._pendingAcquires = this._pendingAcquires.filter(
        (pending) => pending !== deferred
      );
    });

    this._pendingAcquires.push(deferred);
    this._dispense();

    return deferred.promise();
  }

  /**
   * Return the resource to the pool, in case it is no longer required.
   *
   * @param {Object} resource The acquired object to be put back to the pool.
   *
   * @returns {void}
   */
  release(resource /*: RawResource*/) {
    // check to see if this object has already been released
    // (i.e., is back in the pool of this._availableObjects)
    if (
      this._availableObjects.some(
        (resourceWithTimeout) => resourceWithTimeout.resource === resource
      )
    ) {
      this._log(
        "release called twice for the same resource: " + new Error().stack,
        "error"
      );
      return;
    }

    // check to see if this object exists in the `in use` list and remove it
    const index = this._inUseObjects.findIndex(
      (wrappedResource) => wrappedResource.resource === resource
    );
    if (index < 0) {
      this._log(
        "attempt to release an invalid resource: " + new Error().stack,
        "error"
      );
      return;
    }
    const wrappedResource = this._inUseObjects[index];

    // Increment the useCount before seeing if it can be added back to the available list
    wrappedResource.useCount += 1;
    if (wrappedResource.useCount >= this._maxUsesPerResource) {
      // Client reached the max use count, so go ahead and destroy it
      this._log(
        "release() destroying obj - useCount:" +
          wrappedResource.useCount +
          " maxUsesPerResource:" +
          this._maxUsesPerResource,
        "verbose"
      );
      this.destroy(wrappedResource.resource);
      // Since we are not adding the resource back to the availables list, we need to go
      // ahead and call _dispense() in order to ensure the resource replaced (if appropriate)
      // and any pending resource requests are fulfilled.
      this._dispense();
    } else {
      // Move the resource from inUse to available
      this._inUseObjects.splice(index, 1);
      this._addResourceToAvailableObjects(
        wrappedResource.resource,
        wrappedResource.useCount
      );
    }
  }

  /**
   * Request the client to be destroyed. The factory's destroy handler
   * will also be called.
   *
   * This should be called within an acquire() block as an alternative to release().
   *
   * @param {Object} resource The acquired item to be destroyed.
   *
   * @returns {void}
   */
  destroy(resource /*: RawResource*/) {
    const available = this._availableObjects.length;
    const using = this._inUseObjects.length;

    this._availableObjects = this._availableObjects.filter(
      (object) => object.resource !== resource
    );
    this._inUseObjects = this._inUseObjects.filter(
      (object) => object.resource !== resource
    );

    // resource was not removed, then no need to decrement _count
    if (
      available === this._availableObjects.length &&
      using === this._inUseObjects.length
    ) {
      this._ensureMinimum();
      return;
    }

    this._count -= 1;
    if (this._count < 0) this._count = 0;

    this._factory.destroy(resource);
    this._ensureMinimum();
  }

  /**
   * Disallow any new requests and let the request backlog dissipate.
   *
   * @returns {Promise}
   */
  drain() {
    this._log("draining", "info");

    // disable the ability to put more work on the queue.
    this._draining = true;

    const check = (callback) => {
      // wait until all client requests have been satisfied.
      if (this._pendingAcquires.length > 0) {
        // pool is draining so we wont accept new acquires but
        // we need to clear pending acquires
        this._dispense();
        return setTimeout(() => {
          check(callback);
        }, 100);
      }

      // wait until in use object have been released.
      if (this._availableObjects.length !== this._count) {
        return setTimeout(() => {
          check(callback);
        }, 100);
      }

      callback();
    };

    // No error handling needed here.
    // prettier-ignore
    return new Promise/*:: <void> */((resolve) => check(resolve)
    );
  }

  /**
   * Forcibly destroys all clients regardless of timeout.  Intended to be
   * invoked as part of a drain.  Does not prevent the creation of new
   * clients as a result of subsequent calls to acquire.
   *
   * Note that if factory.min > 0, the pool will destroy all idle resources
   * in the pool, but replace them with newly created resources up to the
   * specified factory.min value.  If this is not desired, set factory.min
   * to zero before calling destroyAllNow()
   *
   * @returns {Promise}
   */
  destroyAllNow() {
    this._log("force destroying all objects", "info");

    const willDie = this._availableObjects.slice();
    const todo = willDie.length;

    this._removeIdleScheduled = false;
    clearTimeout(this._removeIdleTimer);

    // prettier-ignore
    return new Promise/*:: <void> */((resolve) => {
      if (todo === 0) {
        return resolve();
      }

      let resource;
      let done = 0;

      while ((resource = willDie.shift())) {
        this.destroy(resource.resource);
        ++done;

        if (done === todo && resolve) {
          return resolve();
        }
      }
    });
  }
}

exports.Pool = Pool;
exports.TimeoutError = require("./TimeoutError").TimeoutError;
