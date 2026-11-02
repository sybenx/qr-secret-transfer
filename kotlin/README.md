# QRST for Kotlin

`src/core` and `src/web` of this repository, ported line for line to Kotlin, as one
JVM library: `cc.aaro.qrst.core` (the protocol, no I/O) and `cc.aaro.qrst.net` (relays,
re-sending, relay selection, one transfer end to end). It runs on Android (API 30 and
up) and on a plain JVM, and depends on `secp256k1-kmp`, OkHttp and `org.json`.

It also carries the published profiles `nostr-nsec` (`NsecProfile`) and
`signer-ticket` (`SignerTicketProfile`). An app's own profiles implement `Profile`.

## Using it

There is no Maven package. Add this repository as a git submodule and include its
Kotlin build:

```kotlin
// settings.gradle.kts
includeBuild("qr-secret-transfer/kotlin")

// app/build.gradle.kts
implementation("cc.aaro.qrst:qrst")
// the secp256k1 natives for your platform, for example on Android:
implementation("fr.acinq.secp256k1:secp256k1-kmp-jni-android:0.19.0")
```

On a plain JVM, also add `org.json:json` (Android ships it). With R8, keep the
secp256k1 bindings: `-keep class fr.acinq.secp256k1.** { *; }`.

## Changing it

Change the TypeScript first, or with it, and keep the two in step: same names, same
order, same behaviour. Then, from the repository root:

```sh
npm ci
cd kotlin && JAVA_HOME=$(/usr/libexec/java_home -v 21) ./gradlew :qrst:test
```

`InteropTest` runs both flows in both directions between this library and the
TypeScript code, over `tools/test-relay.mjs`.
