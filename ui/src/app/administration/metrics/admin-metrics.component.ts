// Author: Preston Lee

import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NgxEchartsDirective } from 'ngx-echarts';
import type { EChartsOption } from 'echarts';
import {
  AdministrationService,
  type AdministrationMetrics,
} from '../../core/services/administration.service.js';

@Component({
  selector: 'app-admin-metrics',
  standalone: true,
  imports: [CommonModule, NgxEchartsDirective],
  templateUrl: './admin-metrics.component.html',
  styleUrls: ['./admin-metrics.component.scss'],
})
export class AdminMetricsComponent implements OnInit {
  public readonly administrationService = inject(AdministrationService);

  public readonly metrics = signal<AdministrationMetrics | null>(null);
  public readonly loading = signal<boolean>(false);
  public readonly errorMessage = signal<string | null>(null);

  // Chart configs signals
  public readonly versionChartOptions = signal<EChartsOption>({});
  public readonly accessModeChartOptions = signal<EChartsOption>({});
  public readonly signupsTimelineOptions = signal<EChartsOption>({});

  ngOnInit(): void {
    this.loadMetrics();
  }

  public loadMetrics(): void {
    this.loading.set(true);
    this.administrationService.getMetrics().subscribe({
      next: (m) => {
        this.metrics.set(m);
        this.setupCharts(m);
        this.loading.set(false);
      },
      error: (err) => {
        this.errorMessage.set(err?.error?.error || 'Failed to load administration metrics.');
        this.loading.set(false);
      },
    });
  }

  private setupCharts(m: AdministrationMetrics): void {
    this.versionChartOptions.set({
      tooltip: { trigger: 'item' },
      legend: { bottom: '0' },
      series: [
        {
          name: 'FHIR Release',
          type: 'pie',
          radius: ['40%', '70%'],
          data: m.charts.versionDistribution,
        },
      ],
    });

    this.accessModeChartOptions.set({
      tooltip: { trigger: 'item' },
      legend: { bottom: '0' },
      series: [
        {
          name: 'Access Mode',
          type: 'pie',
          radius: ['40%', '70%'],
          data: m.charts.accessModeDistribution,
        },
      ],
    });

    const months = m.charts.monthlySignupsTimeline.map((item) => item.month);
    const signupCounts = m.charts.monthlySignupsTimeline.map((item) => item.count);

    this.signupsTimelineOptions.set({
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: months.length > 0 ? months : ['2026-08'] },
      yAxis: { type: 'value' },
      series: [
        {
          name: 'New Signups',
          type: 'bar',
          data: signupCounts.length > 0 ? signupCounts : [1],
          itemStyle: { color: '#0d6efd' },
        },
      ],
    });
  }
}
