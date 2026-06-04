import { useEffect, useState } from 'react'
import { apiBaseUrl } from '../config/env'
import '../App.css'

interface IntegrationTestResult {
  success: boolean
  message: string
  workflowId: string
}

type TestState =
  | { status: 'loading' }
  | { status: 'success'; data: IntegrationTestResult }
  | { status: 'error'; message: string }

async function fetchIntegrationTest(): Promise<IntegrationTestResult> {
  const response = await fetch(`${apiBaseUrl}/test`)

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }

  return response.json() as Promise<IntegrationTestResult>
}

export default function Test() {
  const [state, setState] = useState<TestState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false

    fetchIntegrationTest()
      .then((data) => {
        if (!cancelled) {
          setState({ status: 'success', data })
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          const message =
            error instanceof Error ? error.message : '请求失败'
          setState({ status: 'error', message })
        }
      })

    return () => {
      cancelled = true
    }
  }, [])

  return (
    <section id="center">
      <h1>Core Engine 集成测试</h1>
      {state.status === 'loading' && <p>运行中...</p>}
      {state.status === 'error' && <p>错误: {state.message}</p>}
      {state.status === 'success' && (
        <div>
          <p>状态: {state.data.success ? '成功' : '失败'}</p>
          <p>消息: {state.data.message}</p>
          <p>工作流 ID: {state.data.workflowId}</p>
        </div>
      )}
    </section>
  )
}
