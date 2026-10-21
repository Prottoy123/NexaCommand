import prisma from '../prisma/client.js';
import { ApiError } from '../utils/ApiError.js';

export const calculatePayrollData = async (tenantId) => {
    // Step 1: Define the current month's timeframe
    const today = new Date();
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1, 0, 0, 0, 0);
    const endOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0, 23, 59, 59, 999);

    // Step 2: Fetch active staff and their approved advances for the current month
    const activeStaff = await prisma.user.findMany({
        where: {
            tenantId: tenantId,
            status: "ACTIVE",
            role: { in: ['STAFF', 'BRANCH_MANAGER'] }
        },
        select: {
            id: true,
            fullName: true,
            role: true,
            baseSalary: true,
            earnedCommission: true,
            ewaRequests: {
                where: {
                    status: "APPROVED",
                    createdAt: {
                        gte: startOfMonth,
                        lte: endOfMonth
                    }
                },
                select: {
                    requestedAmount: true
                }
            }
        }
    });

    if (activeStaff.length === 0) {
        throw new ApiError(404, "No active staff found to process payroll.");
    }

    // Step 3: In-memory financial calculation
    let totalCompanyPayroll = 0;
    const payrollDetails = activeStaff.map(staff => {
        // Convert Prisma Decimal to standard JavaScript Number
        const base = Number(staff.baseSalary || 0);
        const commission = Number(staff.earnedCommission || 0);
        
        // Sum up all approved EWAs
        const totalAdvance = staff.ewaRequests.reduce(
            (sum, ewa) => sum + Number(ewa.requestedAmount || 0), 0
        );

        const grossPay = base + commission;
        const netPayable = Math.max(0, grossPay - totalAdvance);

        totalCompanyPayroll += netPayable;

        return {
            userId: staff.id,
            fullName: staff.fullName,
            role: staff.role,
            baseSalary: base,
            earnedCommission: commission,
            totalAdvance: totalAdvance,
            grossPay: grossPay,
            netPayable: netPayable
        };
    });

    return {
        month: today.toLocaleString('default', { month: 'long', year: 'numeric' }),
        totalStaff: activeStaff.length,
        totalCompanyPayroll,
        details: payrollDetails
    };
};