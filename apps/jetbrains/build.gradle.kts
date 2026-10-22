import org.jetbrains.intellij.platform.gradle.IntelliJPlatformType
import org.jetbrains.intellij.platform.gradle.TestFrameworkType
import org.jetbrains.intellij.platform.gradle.tasks.VerifyPluginTask
import org.jetbrains.kotlin.gradle.dsl.JvmDefaultMode
import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.dsl.KotlinVersion

plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "2.4.21"
    id("org.jetbrains.intellij.platform") version "2.19.0"
}

group = "dev.piwitests"
version = providers.gradleProperty("pluginVersion").get()

// The editor service every client ships, built by `npm run editor:build`: the language server, and beside it the
// launcher that opens a recording's browser, the reporter that prints a Playwright project's options, and the
// recorder's IDE bundle with its messages.
val editorDist = layout.projectDirectory.dir("../../packages/editor/dist")
val languageServer = editorDist.file("piwi-language-server.cjs")
val serverFiles = listOf(
    "piwi-language-server.cjs",
    "piwi-recorder-launcher.cjs",
    "piwi-use-reporter.cjs",
    "record-ide.js",
    "record-ide-messages.json",
).map { editorDist.file(it) }

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

// Built with JDK 21, as bytecode for Java 17: the runtime of the oldest supported platform.
kotlin {
    jvmToolchain(21)
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
        // The oldest supported platform (2024.1) bundles Kotlin 1.9.
        apiVersion.set(KotlinVersion.KOTLIN_1_9)
        languageVersion.set(KotlinVersion.KOTLIN_1_9)
        // The platform's interfaces have default methods: a class implementing one needs no bridge to each of them,
        // which the Plugin Verifier would count as a use of every experimental or deprecated one.
        jvmDefault.set(JvmDefaultMode.NO_COMPATIBILITY)
    }
}

dependencies {
    testImplementation("junit:junit:4.13.2")
    intellijPlatform {
        create(providers.gradleProperty("platformType"), providers.gradleProperty("platformVersion"))
        bundledPlugin("JavaScript")
        testFramework(TestFrameworkType.Platform, providers.gradleProperty("platformTestFrameworkVersion").get())
    }
}

intellijPlatform {
    pluginConfiguration {
        version = providers.gradleProperty("pluginVersion")
        ideaVersion {
            sinceBuild = providers.gradleProperty("pluginSinceBuild")
            untilBuild = provider { null }
        }
    }
    signing {
        certificateChain = providers.environmentVariable("CERTIFICATE_CHAIN")
        privateKey = providers.environmentVariable("PRIVATE_KEY")
        password = providers.environmentVariable("PRIVATE_KEY_PASSWORD")
    }
    publishing {
        token = providers.environmentVariable("PUBLISH_TOKEN")
    }
    // `verifyIdes` lists `<type code>:<version>` pairs, comma-separated; each IDE is a large download.
    pluginVerification {
        failureLevel = listOf(
            VerifyPluginTask.FailureLevel.COMPATIBILITY_PROBLEMS,
            VerifyPluginTask.FailureLevel.INVALID_PLUGIN,
        )
        ides {
            providers.gradleProperty("verifyIdes").get().split(",").map { it.trim() }.filter { it.isNotEmpty() }.forEach {
                val (type, ideVersion) = it.split(":")
                create(IntelliJPlatformType.fromCode(type), ideVersion)
            }
        }
    }
    buildSearchableOptions = false
    // Kotlin sources and no GUI forms: nothing for the bytecode instrumenter to add.
    instrumentCode = false
}

tasks {
    withType<JavaCompile> {
        options.release.set(17)
    }
    withType<org.jetbrains.kotlin.gradle.tasks.KotlinJvmCompile> {
        compilerOptions.jvmTarget.set(JvmTarget.JVM_17)
    }
    // The plugin's `server/` holds the editor service's files; a build (buildPlugin, runIde, verifyPlugin) fails
    // without one of them. The tests start the language server from the editor's `dist/` and need none of the others.
    prepareSandbox {
        val files = serverFiles.map { it.asFile }
        doFirst {
            val missing = files.filterNot { it.isFile }
            if (missing.isNotEmpty()) {
                throw GradleException(
                    "The editor service is not built: ${missing.joinToString { it.name }} missing from " +
                        "${missing.first().parentFile}. Run `npm run editor:build -w packages/editor` from the repository root.",
                )
            }
        }
        from(serverFiles) {
            into(pluginName.map { "$it/server" })
        }
    }
    test {
        systemProperty("piwi.editor.server", languageServer.asFile.absolutePath)
    }
    // WebStorm 2024.1's Swagger plugin declares a test service whose class ships with its own tests only.
    prepareTestSandbox {
        disabledPlugins.add("com.intellij.swagger")
    }
}
