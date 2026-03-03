/**
 * GitHub Team Activity Monitor
 * Monitors team members' work and alerts on issues
 */

const { graphql } = require('@octokit/graphql');
const { Octokit } = require('@octokit/rest');

// Configuration
const config = {
  githubToken: process.env.MONITORING_TOKEN,
  organization: "ITV", // e.g., 'my-company'
  teamMembers: process.env.TEAM_MEMBERS?.split(',') || ["Macro80-20","mikokofuyu"], // GitHub usernames
  staleDays: parseInt(process.env.STALE_DAYS) || 7,
  idleDays: parseInt(process.env.IDLE_DAYS) || 3,
  slackWebhook: process.env.SLACK_WEBHOOK, // Optional: for Slack notifications
};

// Initialize Octokit
const octokit = new Octokit({
  auth: config.githubToken,
});

const graphqlWithAuth = graphql.defaults({
  headers: {
    authorization: `token ${config.githubToken}`,
  },
});

/**
 * Fetch team member activity and workload
 */
async function getTeamActivity() {
  const report = {
    timestamp: new Date().toISOString(),
    teamMembers: {},
    alerts: [],
    summary: {
      totalAssignedIssues: 0,
      totalOpenPRs: 0,
      memberCount: config.teamMembers.length,
    },
  };

  for (const member of config.teamMembers) {
    const memberData = await getMemberData(member);
    report.teamMembers[member] = memberData;
    report.summary.totalAssignedIssues += memberData.assignedIssues.length;
    report.summary.totalOpenPRs += memberData.openPRs.length;

    // Check for alerts
    const alerts = checkForAlerts(member, memberData);
    report.alerts.push(...alerts);
  }

  return report;
}

/**
 * Get individual team member's data
 */
async function getMemberData(username) {
  try {
    const query = `
      query($userName:String!) {
        user(login: $userName) {
          name
          login
          repositories(first: 100) {
            nodes {
              name
              owner {
                login
              }
            }
          }
        }
      }
    `;

    const user = await graphqlWithAuth({
      query,
      userName: username,
    });

    // Get assigned issues
    const assignedIssuesResponse = await octokit.rest.search.issuesAndPullRequests({
      q: `assignee:${username} is:open is:issue`,
      per_page: 100,
    });

    // Get open pull requests
    const prResponse = await octokit.rest.search.issuesAndPullRequests({
      q: `author:${username} is:open is:pr`,
      per_page: 100,
    });

    // Get recent activity (commits, comments, etc.)
    const eventResponse = await octokit.rest.activity.listEventsForAuthenticatedUser({
      username,
      per_page: 50,
    });

    return {
      name: user.user.name || username,
      login: username,
      assignedIssues: assignedIssuesResponse.items.map(issue => ({
        title: issue.title,
        url: issue.html_url,
        createdAt: issue.created_at,
        updatedAt: issue.updated_at,
        repository: issue.repository_url.split('/').pop(),
        daysOpen: daysSince(issue.created_at),
        daysSinceUpdate: daysSince(issue.updated_at),
      })),
      openPRs: prResponse.items.map(pr => ({
        title: pr.title,
        url: pr.html_url,
        createdAt: pr.created_at,
        updatedAt: pr.updated_at,
        repository: pr.repository_url.split('/').pop(),
        daysOpen: daysSince(pr.created_at),
        daysSinceReview: daysSince(pr.updated_at),
      })),
      recentActivity: eventResponse.data.slice(0, 10).map(event => ({
        type: event.type,
        repo: event.repo.name,
        createdAt: event.created_at,
      })),
      lastActivityDate: getLastActivityDate(eventResponse.data),
      daysSinceActivity: getLastActivityDate(eventResponse.data)
        ? daysSince(getLastActivityDate(eventResponse.data))
        : null,
    };
  } catch (error) {
    console.error(`Error fetching data for ${username}:`, error.message);
    return {
      name: username,
      login: username,
      error: error.message,
    };
  }
}

/**
 * Check for alert conditions
 */
function checkForAlerts(username, memberData) {
  const alerts = [];

  // Check for stale issues
  memberData.assignedIssues.forEach(issue => {
    if (issue.daysSinceUpdate > config.staleDays) {
      alerts.push({
        type: 'STALE_ISSUE',
        severity: 'warning',
        member: username,
        message: `${username}'s issue "${issue.title}" hasn't been updated in ${issue.daysSinceUpdate} days`,
        details: {
          issue: issue.title,
          url: issue.url,
          repository: issue.repository,
          daysSinceUpdate: issue.daysSinceUpdate,
        },
      });
    }
  });

  // Check for stale PRs
  memberData.openPRs.forEach(pr => {
    if (pr.daysSinceReview > config.staleDays) {
      alerts.push({
        type: 'STALE_PR',
        severity: 'warning',
        member: username,
        message: `${username}'s PR "${pr.title}" is pending review for ${pr.daysSinceReview} days`,
        details: {
          pr: pr.title,
          url: pr.url,
          repository: pr.repository,
          daysSinceUpdate: pr.daysSinceReview,
        },
      });
    }
  });

  // Check for idle team members
  if (
    memberData.daysSinceActivity > config.idleDays &&
    memberData.daysSinceActivity !== null
  ) {
    alerts.push({
      type: 'IDLE_MEMBER',
      severity: 'critical',
      member: username,
      message: `${username} has been inactive for ${memberData.daysSinceActivity} days`,
      details: {
        lastActivityDate: memberData.lastActivityDate,
        daysSinceActivity: memberData.daysSinceActivity,
      },
    });
  }

  // Check for no assigned work
  if (memberData.assignedIssues.length === 0 && memberData.openPRs.length === 0) {
    alerts.push({
      type: 'NO_ACTIVE_WORK',
      severity: 'info',
      member: username,
      message: `${username} has no active assigned issues or open PRs`,
      details: {
        assignedIssues: 0,
        openPRs: 0,
      },
    });
  }

  return alerts;
}

/**
 * Generate a formatted report
 */
function generateReport(activityData) {
  let report = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  TEAM ACTIVITY REPORT
  Generated: ${new Date(activityData.timestamp).toLocaleString()}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📊 SUMMARY
──────────
Total Team Members: ${activityData.summary.memberCount}
Total Assigned Issues: ${activityData.summary.totalAssignedIssues}
Total Open PRs: ${activityData.summary.totalOpenPRs}
Active Alerts: ${activityData.alerts.length}

`;

  // Member breakdown
  report += `\n👥 TEAM MEMBERS STATUS\n──────────────────────\n`;
  for (const [username, data] of Object.entries(activityData.teamMembers)) {
    if (data.error) {
      report += `\n⚠️  ${data.name} (${username})\n  Error: ${data.error}\n`;
      continue;
    }

    report += `\n✓ ${data.name} (${username})\n`;
    report += `  • Assigned Issues: ${data.assignedIssues.length}\n`;
    report += `  • Open PRs: ${data.openPRs.length}\n`;

    if (data.lastActivityDate) {
      report += `  • Last Activity: ${data.lastActivityDate} (${data.daysSinceActivity} days ago)\n`;
    } else {
      report += `  • Last Activity: No recent activity\n`;
    }

    // Show stale items
    const staleIssues = data.assignedIssues.filter(i => i.daysSinceUpdate > config.staleDays);
    if (staleIssues.length > 0) {
      report += `  ⚠️  ${staleIssues.length} stale issue(s)\n`;
    }
  }

  // Alerts section
  if (activityData.alerts.length > 0) {
    report += `\n\n🚨 ALERTS\n─────────\n`;
    const alertsByType = {};

    activityData.alerts.forEach(alert => {
      if (!alertsByType[alert.type]) {
        alertsByType[alert.type] = [];
      }
      alertsByType[alert.type].push(alert);
    });

    for (const [type, alerts] of Object.entries(alertsByType)) {
      report += `\n${type}\n`;
      alerts.forEach(alert => {
        const icon = alert.severity === 'critical' ? '🔴' : '🟡';
        report += `  ${icon} ${alert.message}\n`;
        if (alert.details.url) {
          report += `     ${alert.details.url}\n`;
        }
      });
    }
  }

  report += `\n━━���━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  return report;
}

/**
 * Send report to Slack (optional)
 */
async function sendToSlack(activityData) {
  if (!config.slackWebhook) return;

  const blocks = [];

  // Header
  blocks.push({
    type: 'header',
    text: {
      type: 'plain_text',
      text: '📊 Team Activity Report',
    },
  });

  // Summary section
  blocks.push({
    type: 'section',
    fields: [
      {
        type: 'mrkdwn',
        text: `*Team Members:*\n${activityData.summary.memberCount}`,
      },
      {
        type: 'mrkdwn',
        text: `*Assigned Issues:*\n${activityData.summary.totalAssignedIssues}`,
      },
      {
        type: 'mrkdwn',
        text: `*Open PRs:*\n${activityData.summary.totalOpenPRs}`,
      },
      {
        type: 'mrkdwn',
        text: `*Alerts:*\n${activityData.alerts.length}`,
      },
    ],
  });

  // Alerts section
  if (activityData.alerts.length > 0) {
    blocks.push({
      type: 'divider',
    });

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*🚨 Active Alerts*`,
      },
    });

    activityData.alerts.slice(0, 5).forEach(alert => {
      const emoji = alert.severity === 'critical' ? '🔴' : '🟡';
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${emoji} *${alert.member}:* ${alert.message}`,
        },
      });
    });

    if (activityData.alerts.length > 5) {
      blocks.push({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `_+${activityData.alerts.length - 5} more alerts_`,
          },
        ],
      });
    }
  }

  try {
    const response = await fetch(config.slackWebhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocks }),
    });

    if (!response.ok) {
      console.error('Failed to send Slack message:', response.statusText);
    }
  } catch (error) {
    console.error('Error sending to Slack:', error.message);
  }
}

/**
 * Utility: Calculate days since a date
 */
function daysSince(dateString) {
  const date = new Date(dateString);
  const now = new Date();
  const diffTime = Math.abs(now - date);
  return Math.floor(diffTime / (1000 * 60 * 60 * 24));
}

/**
 * Utility: Get last activity date from events
 */
function getLastActivityDate(events) {
  if (!events || events.length === 0) return null;
  return events[0].created_at;
}

/**
 * Main execution
 */
async function main() {
  console.log('🚀 Starting team activity monitoring...');
  
  try {
    const activityData = await getTeamActivity();
    const report = generateReport(activityData);
    
    console.log(report);
    
    // Send to Slack if configured
    await sendToSlack(activityData);
    
    // Optionally save to file
    const fs = require('fs');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(
      `team-report-${timestamp}.json`,
      JSON.stringify(activityData, null, 2)
    );
    
    console.log('✅ Monitoring complete!');
  } catch (error) {
    console.error('❌ Error during monitoring:', error.message);
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  main();
}

module.exports = {
  getTeamActivity,
  generateReport,
  sendToSlack,
};
