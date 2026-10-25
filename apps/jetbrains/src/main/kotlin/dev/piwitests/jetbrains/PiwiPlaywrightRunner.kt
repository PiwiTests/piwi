package dev.piwitests.jetbrains

import com.intellij.aqua.runners.playwright.js.PlaywrightRunConfiguration
import com.intellij.aqua.runners.playwright.js.PlaywrightRunSettings
import com.intellij.execution.ProgramRunnerUtil
import com.intellij.execution.RunManager
import com.intellij.execution.RunnerAndConfigurationSettings
import com.intellij.execution.configuration.EnvironmentVariablesData
import com.intellij.execution.configurations.ConfigurationTypeUtil
import com.intellij.execution.executors.DefaultRunExecutor
import com.intellij.execution.process.ProcessEvent
import com.intellij.execution.process.ProcessHandler
import com.intellij.execution.process.ProcessListener
import com.intellij.execution.runners.ExecutionEnvironmentBuilder
import com.intellij.execution.runners.ProgramRunner
import com.intellij.execution.ui.RunContentDescriptor
import com.intellij.openapi.project.Project
import com.intellij.util.execution.ParametersListUtil

/**
 * Whether the IDE has its own Playwright runner (WebStorm, IntelliJ IDEA Ultimate): no type of the runner here, so this
 * loads in an IDE without it.
 */
object PlaywrightRunnerGate {
    /** The id of the IDE's Playwright run configuration type. */
    const val TYPE_ID = "JavaScriptTestRunnerPlaywright"

    fun available(): Boolean = ConfigurationTypeUtil.findConfigurationType(TYPE_ID) != null
}

/**
 * Runs tests in the IDE's Playwright runner, with its test tree, Debug and Rerun Failed Tests: a temporary run
 * configuration with the arguments and the environment of the service's command, in the config's folder. Used only
 * once [PlaywrightRunnerGate.available].
 */
internal object PlaywrightRunnerLauncher {
    /** The temporary configuration, made and selected; null when the runner does not take it. On the event thread. */
    fun configure(project: Project, cwd: String, args: List<String>, env: Map<String, String>): RunnerAndConfigurationSettings? {
        val type = ConfigurationTypeUtil.findConfigurationType(PlaywrightRunnerGate.TYPE_ID) ?: return null
        val manager = RunManager.getInstance(project)
        val settings = manager.createConfiguration(Glue.playwrightRunName(args), type.configurationFactories.single())
        val configuration = settings.configuration as? PlaywrightRunConfiguration ?: return null
        configuration.settings = PlaywrightRunSettings.Builder().apply {
            workingDir = cwd
            cliOptions = ParametersListUtil.join(args)
            envData = EnvironmentVariablesData.create(env, true)
        }.build()
        manager.setTemporaryConfiguration(settings)
        return settings
    }

    /**
     * Start the run, [onStart] getting its process and [onEnd] its exit code; false when the runner does not take it. On
     * the event thread.
     */
    fun start(
        project: Project,
        cwd: String,
        args: List<String>,
        env: Map<String, String>,
        onStart: (ProcessHandler) -> Unit = {},
        onEnd: (Int) -> Unit,
    ): Boolean {
        val settings = configure(project, cwd, args, env) ?: return false
        val environment = ExecutionEnvironmentBuilder.createOrNull(DefaultRunExecutor.getRunExecutorInstance(), settings)
            ?.build() ?: return false
        ProgramRunnerUtil.executeConfigurationAsync(
            environment,
            true,
            true,
            object : ProgramRunner.Callback {
                override fun processStarted(descriptor: RunContentDescriptor?) {
                    val process = descriptor?.processHandler ?: return
                    process.addProcessListener(
                        object : ProcessListener {
                            override fun processTerminated(event: ProcessEvent) = onEnd(event.exitCode)
                        },
                    )
                    onStart(process)
                }
            },
        )
        return true
    }
}
