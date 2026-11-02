plugins {
    id("org.jetbrains.kotlin.jvm")
}

// Apps take this build with includeBuild("<submodule>/kotlin"); Gradle then resolves
// implementation("cc.aaro.qrst:qrst") from it.
group = "cc.aaro.qrst"

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}
kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }

sourceSets {
    // The reference's own test vectors, not a copy.
    test { resources.srcDir("../../vectors") }
}

// secp256k1's JVM natives, used only by the tests, need Java 21. The library stays at 17.
configurations.matching { it.name == "testCompileClasspath" || it.name == "testRuntimeClasspath" }.configureEach {
    attributes.attribute(TargetJvmVersion.TARGET_JVM_VERSION_ATTRIBUTE, 21)
}

dependencies {
    api("fr.acinq.secp256k1:secp256k1-kmp:0.19.0")
    api("com.squareup.okhttp3:okhttp:4.12.0")
    // Android ships org.json; on a plain JVM the app brings it.
    compileOnly("org.json:json:20240303")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
    testImplementation("fr.acinq.secp256k1:secp256k1-kmp-jni-jvm:0.19.0")
}
