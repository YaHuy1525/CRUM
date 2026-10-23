import { describe, it, expect } from 'vitest'
import {
  createCustomerTool,
  updateCustomerTool,
  deleteCustomerTool,
} from '../../../src/mastra/tools/customer-writes'

describe('approval-class customer tools', () => {
  it('createCustomerTool has requireApproval as a function', () => {
    expect(typeof createCustomerTool.requireApproval).toBe('function')
  })

  it('createCustomerTool has outputValidation warn', () => {
    expect(createCustomerTool.outputValidation).toBe('warn')
  })

  it('createCustomerTool has beforeApproval', () => {
    expect(typeof createCustomerTool.beforeApproval).toBe('function')
  })

  it('updateCustomerTool has requireApproval as a function', () => {
    expect(typeof updateCustomerTool.requireApproval).toBe('function')
  })

  it('deleteCustomerTool has requireApproval as a function', () => {
    expect(typeof deleteCustomerTool.requireApproval).toBe('function')
  })

  it('all three have the correct ids', () => {
    expect(createCustomerTool.id).toBe('crm.create_customer')
    expect(updateCustomerTool.id).toBe('crm.update_customer')
    expect(deleteCustomerTool.id).toBe('crm.delete_customer')
  })
})
