"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { useCTL, type Assignment, type RMForecast } from "./ctl-context"
import { AlertCircle, Zap, CheckCircle } from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"

interface CuttingPattern {
  coilId: string
  lineId: string
  orderIds: string[]
  sideScrap: number
  endScrap: number
  utilization: number
  changeoverCost: number
  totalScore: number
  coilConsumption: number
  coilBalance: number
  isPartialAllocation?: boolean
  allocatedWeight?: number
  orderAllocations?: Array<{
    orderId: string
    allocatedWeight: number
    isPartial: boolean
  }>
}

export default function OptimizationEngine() {
  const { coils, orders, lines, setProposedAssignments, proposedAssignments, confirmAssignments, setRMForecasts } =
    useCTL()
  const [loading, setLoading] = useState(false)
  const [optimizationLog, setOptimizationLog] = useState<string[]>([])

  const calculateCuttingPattern = (coilId: string, selectedOrderIds: string[]): CuttingPattern | null => {
    const coil = coils.find((c) => c.id === coilId)
    const selectedOrders = orders.filter((o) => selectedOrderIds.includes(o.id))

    if (!coil || selectedOrders.length === 0) return null

    const compatibleLine = lines.find((line) => {
      return (
        coil.width <= line.maxWidth &&
        coil.width >= line.minWidth &&
        coil.thickness <= line.maxThickness &&
        coil.weight <= line.maxWeight
      )
    })

    if (!compatibleLine) return null

    const totalOrderWeight = selectedOrders.reduce((sum, order) => sum + order.weight, 0)

    const allOrdersCompatible = selectedOrders.every((order) => {
      return (
        order.grade === coil.grade &&
        order.thickness === coil.thickness &&
        order.width <= coil.width &&
        order.weight <= coil.weight
      )
    })

    if (!allOrdersCompatible) return null

    const coilConsumption = (totalOrderWeight / coil.weight) * 100
    const coilBalance = 100 - coilConsumption

    if (coilConsumption > 100) return null

    const sideScrap = selectedOrders.reduce((sum, order) => {
      return sum + (coil.width - order.width) * order.length
    }, 0)

    const totalOrderLength = selectedOrders.reduce((sum, order) => {
      return sum + order.length * order.quantity
    }, 0)

    const endScrap = Math.max(0, coil.length - totalOrderLength)
    const totalScrap = sideScrap + endScrap
    const totalMaterial = sideScrap + totalOrderLength
    const utilization = totalMaterial > 0 ? (totalOrderLength / totalMaterial) * 100 : 0

    const orderAllocations = selectedOrders.map((order) => ({
      orderId: order.id,
      allocatedWeight: order.weight,
      isPartial: false,
    }))

    return {
      coilId,
      lineId: compatibleLine.id,
      orderIds: selectedOrderIds,
      sideScrap,
      endScrap,
      utilization,
      changeoverCost: 100,
      totalScore: utilization * 10 - totalScrap / 1000 - 100,
      coilConsumption,
      coilBalance,
      isPartialAllocation: false,
      allocatedWeight: totalOrderWeight,
      orderAllocations,
    }
  }

  const groupCompatibleOrders = (orderIds: string[]): string[][] => {
    const groups: string[][] = []
    const remainingOrders = new Set(orderIds)

    const sortedIds = [...orderIds].sort((a, b) => {
      const orderA = orders.find((o) => o.id === a)
      const orderB = orders.find((o) => o.id === b)
      if (!orderA || !orderB) return 0
      if (orderA.priority !== orderB.priority) return orderA.priority - orderB.priority
      if (orderB.width !== orderA.width) return orderB.width - orderA.width
      return orderB.thickness - orderA.thickness
    })

    for (const firstOrderId of sortedIds) {
      if (!remainingOrders.has(firstOrderId)) continue

      const firstOrder = orders.find((o) => o.id === firstOrderId)
      if (!firstOrder) continue

      const currentGroup = [firstOrderId]
      remainingOrders.delete(firstOrderId)

      for (const otherId of Array.from(remainingOrders)) {
        const otherOrder = orders.find((o) => o.id === otherId)
        if (!otherOrder) continue

        if (
          otherOrder.thickness === firstOrder.thickness &&
          otherOrder.grade === firstOrder.grade &&
          otherOrder.product === firstOrder.product &&
          otherOrder.width <= firstOrder.width + 10 &&
          otherOrder.width >= firstOrder.width - 10
        ) {
          currentGroup.push(otherId)
          remainingOrders.delete(otherId)
        }
      }

      groups.push(currentGroup)
    }

    return groups
  }

  const fulfillOrderWithMultipleCoils = (
    order: (typeof orders)[0],
    availableCoils: typeof coils,
    usedCoilCapacity: Map<string, number>,
  ): CuttingPattern[] => {
    const patterns: CuttingPattern[] = []
    let remainingOrderWeight = order.weight

    const compatibleCoils = availableCoils
      .filter((coil) => {
        return (
          coil.grade === order.grade &&
          coil.thickness === order.thickness &&
          coil.product === order.product &&
          coil.width >= order.width
        )
      })
      .map((coil) => {
        const usedCapacity = usedCoilCapacity.get(coil.id) || 0
        const availableCapacity = coil.weight - usedCapacity
        return { coil, availableCapacity }
      })
      .filter((item) => item.availableCapacity > 0)
      .sort((a, b) => b.availableCapacity - a.availableCapacity)

    for (const { coil, availableCapacity } of compatibleCoils) {
      if (remainingOrderWeight <= 0) break

      const compatibleLine = lines.find((line) => {
        return (
          coil.width <= line.maxWidth &&
          coil.width >= line.minWidth &&
          coil.thickness <= line.maxThickness &&
          coil.weight <= line.maxWeight
        )
      })

      if (!compatibleLine) continue

      const allocatedWeight = Math.min(availableCapacity, remainingOrderWeight)
      const currentUsed = usedCoilCapacity.get(coil.id) || 0
      const newUsed = currentUsed + allocatedWeight
      const coilConsumption = (newUsed / coil.weight) * 100
      const coilBalance = 100 - coilConsumption

      usedCoilCapacity.set(coil.id, newUsed)

      const sideScrap = (coil.width - order.width) * order.length * (allocatedWeight / order.weight)
      const utilization = (allocatedWeight / coil.weight) * 100

      patterns.push({
        coilId: coil.id,
        lineId: compatibleLine.id,
        orderIds: [order.id],
        sideScrap,
        endScrap: 0,
        utilization,
        changeoverCost: 100,
        totalScore: utilization * 10 - sideScrap / 1000 - 100,
        coilConsumption,
        coilBalance,
        isPartialAllocation: true,
        allocatedWeight,
        orderAllocations: [
          {
            orderId: order.id,
            allocatedWeight,
            isPartial: remainingOrderWeight > allocatedWeight,
          },
        ],
      })

      remainingOrderWeight -= allocatedWeight
    }

    return patterns
  }

  const runOptimization = () => {
    setLoading(true)
    const logs: string[] = []
    const patterns: CuttingPattern[] = []
    const usedCoilCapacity = new Map<string, number>()

    logs.push(`Starting optimization with ${coils.length} coils and ${orders.length} orders`)

    const remainingOrders = new Set(orders.map((o) => o.id))
    const usedCoils = new Set<string>()

    const orderGroups = groupCompatibleOrders(Array.from(remainingOrders))
    logs.push(`Grouped ${orders.length} orders into ${orderGroups.length} compatible groups`)

    for (const orderGroup of orderGroups) {
      const groupOrders = orders.filter((o) => orderGroup.includes(o.id))
      if (groupOrders.length === 0) continue

      const maxWidth = Math.max(...groupOrders.map((o) => o.width))
      const commonThickness = groupOrders[0].thickness
      const commonGrade = groupOrders[0].grade
      const commonProduct = groupOrders[0].product
      const totalTonnage = groupOrders.reduce((sum, o) => sum + o.weight, 0)

      let bestPattern: CuttingPattern | null = null
      let bestCoilId: string | null = null

      for (const coil of coils) {
        if (usedCoils.has(coil.id)) continue
        if (coil.thickness !== commonThickness) continue
        if (coil.grade !== commonGrade) continue
        if (coil.product !== commonProduct) continue
        if (coil.width < maxWidth) continue
        if (coil.weight < totalTonnage) continue

        const pattern = calculateCuttingPattern(coil.id, orderGroup)
        if (pattern && (!bestPattern || pattern.totalScore > bestPattern.totalScore)) {
          bestPattern = pattern
          bestCoilId = coil.id
        }
      }

      if (bestPattern && bestCoilId) {
        patterns.push(bestPattern)
        usedCoils.add(bestCoilId)
        usedCoilCapacity.set(bestCoilId, coils.find((c) => c.id === bestCoilId)?.weight || 0)
        orderGroup.forEach((id) => remainingOrders.delete(id))
        logs.push(
          `Group of ${orderGroup.length} orders assigned to coil with ${bestPattern.utilization.toFixed(1)}% utilization`,
        )
      }
    }

    if (remainingOrders.size > 0) {
      logs.push(`--- Pass 2: Multi-coil fulfillment for ${remainingOrders.size} remaining orders ---`)

      const unfulfilledOrdersList = orders
        .filter((o) => remainingOrders.has(o.id))
        .sort((a, b) => a.priority - b.priority)

      for (const order of unfulfilledOrdersList) {
        if (!remainingOrders.has(order.id)) continue

        const availableCoils = coils.filter((c) => {
          const usedCapacity = usedCoilCapacity.get(c.id) || 0
          return usedCapacity < c.weight
        })

        const multiCoilPatterns = fulfillOrderWithMultipleCoils(order, availableCoils, usedCoilCapacity)

        if (multiCoilPatterns.length > 0) {
          const totalAllocated = multiCoilPatterns.reduce((sum, p) => sum + (p.allocatedWeight || 0), 0)

          if (totalAllocated >= order.weight * 0.99) {
            patterns.push(...multiCoilPatterns)
            remainingOrders.delete(order.id)

            multiCoilPatterns.forEach((p) => {
              const coil = coils.find((c) => c.id === p.coilId)
              if (coil && (usedCoilCapacity.get(p.coilId) || 0) >= coil.weight * 0.99) {
                usedCoils.add(p.coilId)
              }
            })

            logs.push(
              `Order ${order.orderId} fulfilled using ${multiCoilPatterns.length} coils (${totalAllocated.toFixed(2)} MT allocated)`,
            )
          } else {
            logs.push(
              `Order ${order.orderId}: Partial fulfillment only (${totalAllocated.toFixed(2)}/${order.weight.toFixed(2)} MT)`,
            )
          }
        }
      }
    }

    logs.push(`Optimization complete: ${patterns.length} assignments created`)
    logs.push(`Unfulfilled orders: ${remainingOrders.size}`)

    if (remainingOrders.size > 0) {
      const forecasts = generateRMForecasts(remainingOrders)
      setRMForecasts(forecasts)
      logs.push(`Generated ${forecasts.length} RM forecasts for unfulfilled orders`)
    } else {
      setRMForecasts([])
    }

    setOptimizationLog(logs)

    const timestamp = Date.now()
    const assignments: Assignment[] = patterns.map((p, idx) => ({
      id: `assign_${timestamp}_${idx}`,
      coilId: p.coilId,
      lineId: p.lineId,
      orderIds: p.orderIds,
      sideScrap: p.sideScrap,
      endScrap: p.endScrap,
      utilization: p.utilization,
      changeoverCost: p.changeoverCost,
      totalScore: p.totalScore,
      status: "proposed",
      coilConsumption: p.coilConsumption,
      coilBalance: p.coilBalance,
      isPartialAllocation: p.isPartialAllocation,
      allocatedWeight: p.allocatedWeight,
      orderAllocations: p.orderAllocations,
    }))

    setProposedAssignments(assignments)
    setLoading(false)
  }

  const generateRMForecasts = (unfulfilledOrderIds: Set<string>): RMForecast[] => {
    const forecasts: RMForecast[] = []
    const unfulfilledOrders = orders.filter((o) => unfulfilledOrderIds.has(o.id))

    const groupedBySpec = new Map<string, typeof unfulfilledOrders>()

    unfulfilledOrders.forEach((order) => {
      const key = `${order.thickness}_${order.grade}`
      if (!groupedBySpec.has(key)) {
        groupedBySpec.set(key, [])
      }
      groupedBySpec.get(key)!.push(order)
    })

    groupedBySpec.forEach((groupOrders) => {
      if (!groupOrders || groupOrders.length === 0) return

      const avgWidth = Math.max(...groupOrders.map((o) => o.width ?? 0)) + 20
      const totalWeight = groupOrders.reduce((sum, o) => {
        const orderWeight = typeof o.weight === "number" && !isNaN(o.weight) ? o.weight : 0
        return sum + orderWeight
      }, 0)

      const orderDetails = groupOrders.map((o) => {
        const orderWeight = typeof o.weight === "number" && !isNaN(o.weight) ? o.weight : 0
        return {
          orderId: o.id,
          requiredWidth: o.width ?? 0,
          requiredLength: o.length ?? 0,
          quantity: o.quantity ?? 1,
          estimatedWeight: orderWeight,
        }
      })

      const thickness = groupOrders[0]?.thickness ?? 0
      const grade = groupOrders[0]?.grade ?? "Standard"
      const recommendedWeight = Math.max(0, totalWeight > 0 ? totalWeight * 1.1 : 0)

      if (!isNaN(recommendedWeight) && isFinite(recommendedWeight)) {
        forecasts.push({
          id: `forecast_${Date.now()}_${Math.random()}`,
          recommendedWidth: Math.max(0, Math.ceil(avgWidth ?? 0)),
          recommendedThickness: Math.max(0, thickness ?? 0),
          recommendedWeight: Math.max(0, Math.ceil(recommendedWeight)),
          unfulfilled: groupOrders.map((o) => o.id),
          quantity: groupOrders.length,
          grade: grade,
          orderDetails,
        })
      }
    })

    return forecasts
  }

  return (
    <div className="space-y-6">
      <Card className="p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold">Optimization Engine</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Run the optimization algorithm to generate optimal coil-to-line assignments with intelligent order
              grouping and multi-coil fulfillment
            </p>
          </div>
          <Button onClick={runOptimization} disabled={loading || coils.length === 0 || orders.length === 0}>
            <Zap className="mr-2 h-4 w-4" />
            {loading ? "Optimizing..." : "Run Optimization"}
          </Button>
        </div>
      </Card>

      {coils.length === 0 || orders.length === 0 ? (
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>Please add at least one coil and one order before running optimization.</AlertDescription>
        </Alert>
      ) : null}

      {optimizationLog.length > 0 && (
        <Card className="p-6">
          <h3 className="mb-4 font-semibold">Optimization Log</h3>
          <div className="space-y-2 text-sm font-mono">
            {optimizationLog.map((log, idx) => (
              <div key={idx} className="text-muted-foreground">
                &gt; {log}
              </div>
            ))}
          </div>
        </Card>
      )}

      {proposedAssignments.length > 0 && (
        <Card className="p-6">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="font-semibold">Proposed Assignments ({proposedAssignments.length})</h3>
            <Button onClick={confirmAssignments} size="sm">
              <CheckCircle className="mr-2 h-4 w-4" />
              Confirm All
            </Button>
          </div>
          <div className="space-y-3 max-h-96 overflow-y-auto">
            {proposedAssignments.map((pattern, idx) => {
              const coil = coils.find((c) => c.id === pattern.coilId)
              const line = lines.find((l) => l.id === pattern.lineId)
              const utilization =
                typeof pattern.utilization === "number" && isFinite(pattern.utilization) ? pattern.utilization : 0
              const sideScrap =
                typeof pattern.sideScrap === "number" && isFinite(pattern.sideScrap) ? pattern.sideScrap : 0
              const endScrap = typeof pattern.endScrap === "number" && isFinite(pattern.endScrap) ? pattern.endScrap : 0
              const coilConsumption =
                typeof pattern.coilConsumption === "number" && isFinite(pattern.coilConsumption)
                  ? pattern.coilConsumption
                  : 0
              const coilBalance =
                typeof pattern.coilBalance === "number" && isFinite(pattern.coilBalance) ? pattern.coilBalance : 0
              const totalScore =
                typeof pattern.totalScore === "number" && isFinite(pattern.totalScore) ? pattern.totalScore : 0
              const allocatedWeight =
                typeof pattern.allocatedWeight === "number" && isFinite(pattern.allocatedWeight)
                  ? pattern.allocatedWeight
                  : 0

              return (
                <div
                  key={idx}
                  className={`border rounded-lg p-4 ${pattern.isPartialAllocation ? "border-yellow-400 bg-yellow-50" : "border-border"}`}
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <h4 className="font-semibold flex items-center gap-2">
                        {coil?.coilId} → {line?.name}
                        {pattern.isPartialAllocation && (
                          <span className="text-xs bg-yellow-200 text-yellow-800 px-2 py-0.5 rounded">Partial</span>
                        )}
                      </h4>
                      <div className="mt-2 grid grid-cols-2 gap-2 text-sm text-muted-foreground">
                        <div>Utilization: {utilization.toFixed(1)}%</div>
                        <div>Side Scrap: {(sideScrap / 1000).toFixed(2)} m²</div>
                        <div>End Scrap: {(endScrap / 1000).toFixed(2)} m²</div>
                        <div>Orders: {pattern.orderIds.length}</div>
                        <div>Coil Consumption: {coilConsumption.toFixed(1)}%</div>
                        <div>Coil Balance: {coilBalance.toFixed(1)}%</div>
                        {pattern.isPartialAllocation && (
                          <div className="col-span-2 text-yellow-700">
                            Allocated Weight: {allocatedWeight.toFixed(2)} MT
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-lg font-bold text-primary">{totalScore.toFixed(0)}</div>
                      <div className="text-xs text-muted-foreground">Score</div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </Card>
      )}
    </div>
  )
}
